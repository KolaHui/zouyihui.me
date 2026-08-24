(() => {
  'use strict';

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const mix = (from, to, t) => from + (to - from) * t;
  const smooth = (edge0, edge1, value) => {
    const t = clamp((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  };
  const wrap = (value, count) => {
    let wrapped = (value + count / 2) % count;
    if (wrapped < 0) wrapped += count;
    return wrapped - count / 2;
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const intro = document.querySelector('.intro');
  const chrome = document.querySelector('.chrome');
  const interlude = document.querySelector('.interlude');
  const orbitSection = document.querySelector('.orbit-story');
  const orbitStage = document.querySelector('.orbit-stage');
  const orbitCards = [...document.querySelectorAll('.art-card')];
  const orbitNumber = document.querySelector('.orbit-hud__number');
  const orbitTitle = document.querySelector('.orbit-hud__title');
  const orbitProgress = document.querySelector('.orbit-progress i');
  const stackSection = document.querySelector('.stack-story');
  const storyCards = [...document.querySelectorAll('.story-card')];
  const storyCopies = [...document.querySelectorAll('.story-copy__block')];
  const storyCounter = document.querySelector('.story-counter span');
  const orbitRenderCache = orbitCards.map(() => ({ visible: null, transform: '', opacity: '', zIndex: '' }));

  const motion = {
    orbit: 0,
    orbitTarget: 0,
    story: 0,
    storyTarget: 0,
    drag: 0,
    dragVelocity: 0,
    dragging: false,
    pointerId: null,
    pointerX: 0,
    pointerTime: 0,
    lastActive: -1
  };

  const runtime = {
    rafId: 0,
    lastRenderTime: 0,
    minimumFrameInterval: 15,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    metrics: { orbitStart: 0, orbitTravel: 1, storyStart: 0, storyTravel: 1 },
    orbitVisible: false,
    storyVisible: false,
    orbitDirty: true,
    storyDirty: true,
    diagnostics: new URLSearchParams(window.location.search).has('perf'),
    lastOrbitProgress: '',
    stats: { callbacks: 0, frames: 0, skippedCallbacks: 0, orbitRenders: 0, storyRenders: 0, styleWrites: 0, culledCards: 0 }
  };

  function refreshMetrics() {
    runtime.metrics.orbitStart = orbitSection.offsetTop;
    runtime.metrics.orbitTravel = Math.max(1, orbitSection.offsetHeight - runtime.viewportHeight);
    runtime.metrics.storyStart = stackSection.offsetTop;
    runtime.metrics.storyTravel = Math.max(1, stackSection.offsetHeight - runtime.viewportHeight);
  }

  function sectionProgress(start, travel) {
    if (travel <= 0) return 0;
    return clamp((window.scrollY - start) / travel);
  }

  function scheduleFrame() {
    if (runtime.rafId || document.hidden) return;
    runtime.rafId = requestAnimationFrame(frame);
  }

  function updateTargets() {
    const nextOrbit = sectionProgress(runtime.metrics.orbitStart, runtime.metrics.orbitTravel);
    const nextStory = sectionProgress(runtime.metrics.storyStart, runtime.metrics.storyTravel);
    if (nextOrbit !== motion.orbitTarget) {
      motion.orbitTarget = nextOrbit;
      runtime.orbitDirty = true;
    }
    if (nextStory !== motion.storyTarget) {
      motion.storyTarget = nextStory;
      runtime.storyDirty = true;
    }
    scheduleFrame();
  }

  function renderOrbit(progress) {
    const count = orbitCards.length;
    const isMobile = runtime.viewportWidth < 760;
    const scrollTurns = progress * (isMobile ? 8.4 : 10.5);
    const offset = scrollTurns + motion.drag;
    const spacing = Math.min(runtime.viewportWidth * (isMobile ? .22 : .135), isMobile ? 118 : 205);
    const perspective = isMobile ? 900 : 1300;
    const cardWidth = isMobile ? 124.8 : clamp(runtime.viewportWidth * .14, 144, 216);
    let nearest = { index: 0, distance: Infinity };

    orbitCards.forEach((card, index) => {
      const cache = orbitRenderCache[index];
      const slot = wrap(index - offset, count);
      const distance = Math.abs(slot);
      const edge = count / 2;
      const x = slot * spacing;
      const z = -570 + Math.pow(distance / edge, 1.52) * (isMobile ? 660 : 920);
      const y = Math.sin(slot * .8) * (isMobile ? 12 : 23);
      const rotation = slot * (isMobile ? -5 : -8.2);
      const opacity = clamp((edge - distance) / 1.05);
      const projectedScale = perspective / (perspective - z);
      const projectedX = x * projectedScale;
      const visibleRange = isMobile ? 3.65 : 4.65;
      const isVisible = opacity > .01 && distance < visibleRange && Math.abs(projectedX) < runtime.viewportWidth * .5 + cardWidth * projectedScale * .45;

      if (cache.visible !== isVisible) {
        cache.visible = isVisible;
        card.classList.toggle('is-visible', isVisible);
        card.style.visibility = isVisible ? 'visible' : 'hidden';
        runtime.stats.styleWrites += 1;
      }

      if (!isVisible) {
        runtime.stats.culledCards += 1;
        if (distance < nearest.distance) nearest = { index, distance };
        return;
      }

      const transform = `translate(-50%, -50%) translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateY(${rotation.toFixed(2)}deg)`;
      const nextOpacity = opacity.toFixed(2);
      const nextZIndex = String(Math.round(z + 1000));
      if (cache.transform !== transform) {
        cache.transform = transform;
        card.style.transform = transform;
        runtime.stats.styleWrites += 1;
      }
      if (cache.opacity !== nextOpacity) {
        cache.opacity = nextOpacity;
        card.style.opacity = nextOpacity;
        runtime.stats.styleWrites += 1;
      }
      if (cache.zIndex !== nextZIndex) {
        cache.zIndex = nextZIndex;
        card.style.zIndex = nextZIndex;
        runtime.stats.styleWrites += 1;
      }

      if (distance < nearest.distance) nearest = { index, distance };
    });

    if (nearest.index !== motion.lastActive) {
      const active = orbitCards[nearest.index];
      motion.lastActive = nearest.index;
      orbitNumber.textContent = `${String(nearest.index + 1).padStart(2, '0')} / ${count}`;
      orbitTitle.textContent = active.dataset.title;
    }

    const nextProgress = progress.toFixed(4);
    if (runtime.lastOrbitProgress !== nextProgress) {
      runtime.lastOrbitProgress = nextProgress;
      orbitProgress.style.transform = `scaleX(${nextProgress})`;
      runtime.stats.styleWrites += 1;
    }
  }

  const state = (x, y, r, s, o = 1) => ({ x, y, r, s, o });
  const interpolateState = (a, b, t) => ({
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    r: mix(a.r, b.r, t),
    s: mix(a.s, b.s, t),
    o: mix(a.o, b.o, t)
  });

  function storyState(index, progress) {
    const middle = (storyCards.length - 1) / 2;
    const relative = index - middle;
    const isMobile = runtime.viewportWidth < 760;
    const width = runtime.viewportWidth;
    const height = runtime.viewportHeight;

    const stack = state(relative * 1.5, relative * -1.2 + (isMobile ? height * .15 : 0), relative * .7, .62, index === storyCards.length - 1 ? 1 : .78);
    const fan = state(relative * (isMobile ? 37 : Math.min(width * .066, 90)), Math.abs(relative) * (isMobile ? 9 : 14) + (isMobile ? height * .15 : 24), relative * (isMobile ? 5.2 : 6.4), 1, 1);
    const featureMain = state(isMobile ? 0 : width * .23, isMobile ? height * .19 : 4, 0, isMobile ? 1.62 : 2.35, 1);
    const featureOther = state((isMobile ? -width * .29 : width * .12) + relative * 15, (isMobile ? height * .26 : height * .29) + Math.abs(relative) * 3, relative * 1.8, .54, .16);
    const feature = index === storyCards.length - 1 ? featureMain : featureOther;
    const sideFan = state((isMobile ? 0 : width * .2) + relative * (isMobile ? 32 : 51), (isMobile ? height * .18 : height * .16) + Math.abs(relative) * 7, relative * -4.3, isMobile ? .78 : .92, 1);
    const finish = state(relative * 2, (isMobile ? height * .18 : height * .12) + relative * -1, relative * -.6, .58, index === 0 ? 1 : .7);

    if (progress < .23) return interpolateState(stack, fan, smooth(.03, .23, progress));
    if (progress < .48) return interpolateState(fan, feature, smooth(.26, .48, progress));
    if (progress < .72) return interpolateState(feature, sideFan, smooth(.52, .72, progress));
    return interpolateState(sideFan, finish, smooth(.78, .98, progress));
  }

  function renderStory(progress) {
    storyCards.forEach((card, index) => {
      const pose = storyState(index, progress);
      card.style.transform = `translate(-50%, -50%) translate3d(${pose.x}px, ${pose.y}px, 0) rotate(${pose.r}deg) scale(${pose.s})`;
      card.style.opacity = pose.o.toFixed(3);
      card.style.zIndex = String(index + (index === storyCards.length - 1 && progress > .28 && progress < .61 ? 20 : 0));
      runtime.stats.styleWrites += 3;
    });

    const weights = [
      1 - smooth(.26, .38, progress),
      smooth(.31, .43, progress) * (1 - smooth(.66, .75, progress)),
      smooth(.69, .79, progress)
    ];

    storyCopies.forEach((copy, index) => {
      const opacity = weights[index];
      copy.style.opacity = opacity.toFixed(3);
      copy.style.transform = `translateY(calc(-50% + ${mix(18, 0, opacity)}px))`;
      runtime.stats.styleWrites += 2;
    });

    const scene = progress < .29 ? 1 : progress < .55 ? 2 : progress < .78 ? 3 : 4;
    storyCounter.textContent = `0${scene}`;
  }

  function frame(timestamp) {
    runtime.rafId = 0;
    runtime.stats.callbacks += 1;

    if (runtime.lastRenderTime && timestamp - runtime.lastRenderTime < runtime.minimumFrameInterval) {
      runtime.stats.skippedCallbacks += 1;
      scheduleFrame();
      return;
    }

    runtime.stats.frames += 1;

    const elapsed = runtime.lastRenderTime ? Math.min(50, timestamp - runtime.lastRenderTime) : 16.667;
    const frameScale = elapsed / 16.667;
    const response = reduceMotion.matches ? 1 : 1 - Math.pow(.87, frameScale);
    runtime.lastRenderTime = timestamp;

    let orbitMoving = false;
    let storyMoving = false;
    let inertiaMoving = false;

    if (runtime.orbitVisible) {
      const delta = motion.orbitTarget - motion.orbit;
      if (Math.abs(delta) > .0001) {
        motion.orbit += delta * response;
        orbitMoving = true;
        runtime.orbitDirty = true;
      } else {
        motion.orbit = motion.orbitTarget;
      }
    } else {
      motion.orbit = motion.orbitTarget;
      motion.dragVelocity = 0;
    }

    if (runtime.storyVisible) {
      const delta = motion.storyTarget - motion.story;
      if (Math.abs(delta) > .0001) {
        motion.story += delta * response;
        storyMoving = true;
        runtime.storyDirty = true;
      } else {
        motion.story = motion.storyTarget;
      }
    } else {
      motion.story = motion.storyTarget;
    }

    if (runtime.orbitVisible && !motion.dragging && Math.abs(motion.dragVelocity) > .0001) {
      motion.drag += motion.dragVelocity * frameScale;
      motion.dragVelocity *= Math.pow(.92, frameScale);
      inertiaMoving = true;
      runtime.orbitDirty = true;
    }

    if (runtime.orbitVisible && runtime.orbitDirty) {
      renderOrbit(motion.orbit);
      runtime.orbitDirty = false;
      runtime.stats.orbitRenders += 1;
    }
    if (runtime.storyVisible && runtime.storyDirty) {
      renderStory(motion.story);
      runtime.storyDirty = false;
      runtime.stats.storyRenders += 1;
    }

    if (orbitMoving || storyMoving || inertiaMoving || motion.dragging) {
      scheduleFrame();
    } else {
      runtime.lastRenderTime = 0;
    }
  }

  orbitStage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    motion.dragging = true;
    motion.pointerId = event.pointerId;
    motion.pointerX = event.clientX;
    motion.pointerTime = performance.now();
    motion.dragVelocity = 0;
    orbitStage.setPointerCapture(event.pointerId);
    runtime.orbitDirty = true;
    scheduleFrame();
  });

  orbitStage.addEventListener('pointermove', (event) => {
    if (!motion.dragging || event.pointerId !== motion.pointerId) return;
    const now = performance.now();
    const deltaX = event.clientX - motion.pointerX;
    const deltaTime = Math.max(8, now - motion.pointerTime);
    const delta = -deltaX / Math.max(70, runtime.viewportWidth * .075);
    motion.drag += delta;
    motion.dragVelocity = (delta / deltaTime) * 16;
    motion.pointerX = event.clientX;
    motion.pointerTime = now;
    runtime.orbitDirty = true;
    scheduleFrame();
  });

  function endDrag(event) {
    if (!motion.dragging || event.pointerId !== motion.pointerId) return;
    motion.dragging = false;
    motion.pointerId = null;
    scheduleFrame();
  }

  orbitStage.addEventListener('pointerup', endDrag);
  orbitStage.addEventListener('pointercancel', endDrag);

  orbitStage.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    motion.drag += event.key === 'ArrowRight' ? 1 : -1;
    runtime.orbitDirty = true;
    scheduleFrame();
  });

  const visibilityObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const isActive = entry.isIntersecting;
      if (entry.target === orbitSection) {
        runtime.orbitVisible = isActive;
        runtime.orbitDirty = isActive;
        orbitSection.classList.toggle('is-active', isActive);
      } else if (entry.target === stackSection) {
        runtime.storyVisible = isActive;
        runtime.storyDirty = isActive;
        stackSection.classList.toggle('is-active', isActive);
      }
    });
    scheduleFrame();
  }, { rootMargin: '35% 0px' });

  visibilityObserver.observe(orbitSection);
  visibilityObserver.observe(stackSection);

  const chromeObserver = new IntersectionObserver(([entry]) => {
    chrome.classList.toggle('is-inverted', entry.isIntersecting && entry.intersectionRatio > .35);
  }, { threshold: [.35] });
  chromeObserver.observe(interlude);

  window.addEventListener('scroll', updateTargets, { passive: true });
  window.addEventListener('resize', () => {
    runtime.viewportWidth = window.innerWidth;
    runtime.viewportHeight = window.innerHeight;
    refreshMetrics();
    runtime.orbitDirty = true;
    runtime.storyDirty = true;
    updateTargets();
  }, { passive: true });
  reduceMotion.addEventListener('change', () => {
    runtime.orbitDirty = true;
    runtime.storyDirty = true;
    updateTargets();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (runtime.rafId) cancelAnimationFrame(runtime.rafId);
      runtime.rafId = 0;
      runtime.lastRenderTime = 0;
      motion.dragVelocity = 0;
      return;
    }
    runtime.orbitDirty = true;
    runtime.storyDirty = true;
    updateTargets();
  });

  if (intro) {
    if (reduceMotion.matches) {
      intro.remove();
    } else {
      intro.addEventListener('animationend', (event) => {
        if (event.animationName === 'intro-out') intro.remove();
      }, { once: true });
    }
  }

  if (runtime.diagnostics) {
    window.__motionDiagnostics = () => ({
      ...runtime.stats,
      rafRunning: Boolean(runtime.rafId),
      orbitVisible: runtime.orbitVisible,
      storyVisible: runtime.storyVisible,
      orbitProgress: Number(motion.orbit.toFixed(4)),
      storyProgress: Number(motion.story.toFixed(4))
    });
  }

  refreshMetrics();
  updateTargets();
  scheduleFrame();
})();
