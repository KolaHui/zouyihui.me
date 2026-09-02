/* 空尘 · 三叶结 —— 首页标志引擎
   ============================================================
   这是 logo/12-定格视角/液态金属-定格.html 的**发行版**：
   几何、场、着色器**逐字照搬**，一个参数都没动，所以和
   `12-定格视角/定版交付/` 里的静帧与视频逐像素同源。

   相对实时版只做了三件减法（都不影响画面）：
     · 去掉控制台、拖拽、颜色/波纹调节等页面 UI
     · 去掉 TINTS 备选色（定版就是 colorTint #5892B8）
     · T_HOLD 4.00 → 2.90，对齐 final12.py 的 LOCK_T（实时版停在旧值）

   以及一件加法：stateAt / fieldAt / draw 多了个可选的 nMax，
   只压低**成形途中**的站数（默认仍是 SHAPE.N = 170）。
   落定帧不受影响 —— draw 在冻结点强制换回 SHAPE.N，实测与定版逐像素相同（差 0）。
   首页拿它把 170 站的 54ms/帧降到 96 站的 26ms，才跑得满 30fps；
   代价是成形途中平均差 0.213/255，比定版动画相邻两帧的 0.415 还小一半。

   定版参数（改任何一个都不再是这个 logo）：
     t 2.90 · ax 1.926 · ay −0.148 · az 0.000 · #5892B8 · pale 0.65 · 波纹 0

   ⚠️ 场的分辨率 FIELD 不能动。着色器里 blurEdge3x3 的半径 6. 和断口
      gap 13 的单位都是**场的纹理像素**，场一改清晰度，材质就跟着变
      —— 见 12-定格视角/定版说明.md 第四节踩过的坑。

   实时版（JS）和离线版（Python）是同一套数学的两份实现，改一边要改两边。
   ============================================================ */

const FRAG = "#version 300 es\nprecision mediump float;\n\nuniform sampler2D u_image;\nuniform float u_imageAspectRatio;\n\nuniform vec2 u_resolution;\nuniform float u_time;\n\nuniform vec4 u_colorBack;\nuniform vec4 u_colorTint;\n\nuniform float u_softness;\nuniform float u_repetition;\nuniform float u_shiftRed;\nuniform float u_shiftBlue;\nuniform float u_distortion;\nuniform float u_contour;\nuniform float u_angle;\nuniform float u_pale;\n\nuniform float u_shape;\nuniform bool u_isImage;\n\nin vec2 v_objectUV;\nin vec2 v_responsiveUV;\nin vec2 v_responsiveBoxGivenSize;\nin vec2 v_imageUV;\n\nout vec4 fragColor;\n\n\n#define TWO_PI 6.28318530718\n#define PI 3.14159265358979323846\n\n\nvec2 rotate(vec2 uv, float th) {\n  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;\n}\n\n\nvec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }\nfloat snoise(vec2 v) {\n  const vec4 C = vec4(0.211324865405187, 0.366025403784439,\n    -0.577350269189626, 0.024390243902439);\n  vec2 i = floor(v + dot(v, C.yy));\n  vec2 x0 = v - i + dot(i, C.xx);\n  vec2 i1;\n  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);\n  vec4 x12 = x0.xyxy + C.xxzz;\n  x12.xy -= i1;\n  i = mod(i, 289.0);\n  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))\n    + i.x + vec3(0.0, i1.x, 1.0));\n  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),\n      dot(x12.zw, x12.zw)), 0.0);\n  m = m * m;\n  m = m * m;\n  vec3 x = 2.0 * fract(p * C.www) - 1.0;\n  vec3 h = abs(x) - 0.5;\n  vec3 ox = floor(x + 0.5);\n  vec3 a0 = x - ox;\n  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);\n  vec3 g;\n  g.x = a0.x * x0.x + h.x * x0.y;\n  g.yz = a0.yz * x12.xz + h.yz * x12.yw;\n  return 130.0 * dot(m, g);\n}\n\n\nfloat getColorChanges(float c1, float c2, float stripe_p, vec3 w, float blur, float bump, float tint) {\n\n  float ch = mix(c2, c1, smoothstep(.0, 2. * blur, stripe_p));\n\n  float border = w[0];\n  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));\n\n  if (u_isImage == true) {\n    bump = smoothstep(.2, .8, bump);\n  }\n  border = w[0] + .4 * (1. - bump) * w[1];\n  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));\n\n  border = w[0] + .5 * (1. - bump) * w[1];\n  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));\n\n  border = w[0] + w[1];\n  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));\n\n  float gradient_t = (stripe_p - w[0] - w[1]) / w[2];\n  float gradient = mix(c1, c2, smoothstep(0., 1., gradient_t));\n  ch = mix(ch, gradient, smoothstep(border, border + .5 * blur, stripe_p));\n\n  // Tint color is applied with color burn blending\n  ch = mix(ch, 1. - min(1., (1. - ch) / max(tint, 0.0001)), u_colorTint.a);\n  return ch;\n}\n\nfloat getImgFrame(vec2 uv, float th) {\n  float frame = 1.;\n  frame *= smoothstep(0., th, uv.y);\n  frame *= 1.0 - smoothstep(1. - th, 1., uv.y);\n  frame *= smoothstep(0., th, uv.x);\n  frame *= 1.0 - smoothstep(1. - th, 1., uv.x);\n  return frame;\n}\n\nfloat blurEdge3x3(sampler2D tex, vec2 uv, vec2 dudx, vec2 dudy, float radius, float centerSample) {\n  vec2 texel = 1.0 / vec2(textureSize(tex, 0));\n  vec2 r = radius * texel;\n\n  float w1 = 1.0, w2 = 2.0, w4 = 4.0;\n  float norm = 16.0;\n  float sum = w4 * centerSample;\n\n  sum += w2 * textureGrad(tex, uv + vec2(0.0, -r.y), dudx, dudy).r;\n  sum += w2 * textureGrad(tex, uv + vec2(0.0, r.y), dudx, dudy).r;\n  sum += w2 * textureGrad(tex, uv + vec2(-r.x, 0.0), dudx, dudy).r;\n  sum += w2 * textureGrad(tex, uv + vec2(r.x, 0.0), dudx, dudy).r;\n\n  sum += w1 * textureGrad(tex, uv + vec2(-r.x, -r.y), dudx, dudy).r;\n  sum += w1 * textureGrad(tex, uv + vec2(r.x, -r.y), dudx, dudy).r;\n  sum += w1 * textureGrad(tex, uv + vec2(-r.x, r.y), dudx, dudy).r;\n  sum += w1 * textureGrad(tex, uv + vec2(r.x, r.y), dudx, dudy).r;\n\n  return sum / norm;\n}\n\nfloat lst(float edge0, float edge1, float x) {\n  return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);\n}\n\nvoid main() {\n\n  const float firstFrameOffset = 2.8;\n  float t = .3 * (u_time + firstFrameOffset);\n\n  vec2 uv = v_imageUV;\n  vec2 dudx = dFdx(v_imageUV);\n  vec2 dudy = dFdy(v_imageUV);\n  vec4 img = textureGrad(u_image, uv, dudx, dudy);\n\n  if (u_isImage == false) {\n    uv = v_objectUV + .5;\n    uv.y = 1. - uv.y;\n  }\n\n  float cycleWidth = u_repetition;\n  float edge = 0.;\n  float contOffset = 1.;\n\n  vec2 rotatedUV = uv - vec2(.5);\n  float angle = (-u_angle + 70.) * PI / 180.;\n  float cosA = cos(angle);\n  float sinA = sin(angle);\n  rotatedUV = vec2(\n  rotatedUV.x * cosA - rotatedUV.y * sinA,\n  rotatedUV.x * sinA + rotatedUV.y * cosA\n  ) + vec2(.5);\n\n  if (u_isImage == true) {\n    float edgeRaw = img.r;\n    edge = blurEdge3x3(u_image, uv, dudx, dudy, 6., edgeRaw);\n    edge = pow(edge, 1.6);\n    edge *= mix(0.0, 1.0, smoothstep(0.0, 0.4, u_contour));\n  } else {\n    if (u_shape < 1.) {\n      // full-fill on canvas\n      vec2 borderUV = v_responsiveUV + .5;\n      float ratio = v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;\n      vec2 mask = min(borderUV, 1. - borderUV);\n      vec2 pixel_thickness = 250. / v_responsiveBoxGivenSize;\n      float maskX = smoothstep(0.0, pixel_thickness.x, mask.x);\n      float maskY = smoothstep(0.0, pixel_thickness.y, mask.y);\n      maskX = pow(maskX, .25);\n      maskY = pow(maskY, .25);\n      edge = clamp(1. - maskX * maskY, 0., 1.);\n\n      uv = v_responsiveUV;\n      if (ratio > 1.) {\n        uv.y /= ratio;\n      } else {\n        uv.x *= ratio;\n      }\n      uv += .5;\n      uv.y = 1. - uv.y;\n\n      cycleWidth *= 2.;\n      contOffset = 1.5;\n\n    } else if (u_shape < 2.) {\n      // circle\n      vec2 shapeUV = uv - .5;\n      shapeUV *= .67;\n      edge = pow(clamp(3. * length(shapeUV), 0., 1.), 18.);\n    } else if (u_shape < 3.) {\n      // daisy\n      vec2 shapeUV = uv - .5;\n      shapeUV *= 1.68;\n\n      float r = length(shapeUV) * 2.;\n      float a = atan(shapeUV.y, shapeUV.x) + .2;\n      r *= (1. + .05 * sin(3. * a + 2. * t));\n      float f = abs(cos(a * 3.));\n      edge = smoothstep(f, f + .7, r);\n      edge *= edge;\n\n      uv *= .8;\n      cycleWidth *= 1.6;\n\n    } else if (u_shape < 4.) {\n      // diamond\n      vec2 shapeUV = uv - .5;\n      shapeUV = rotate(shapeUV, .25 * PI);\n      shapeUV *= 1.42;\n      shapeUV += .5;\n      vec2 mask = min(shapeUV, 1. - shapeUV);\n      vec2 pixel_thickness = vec2(.15);\n      float maskX = smoothstep(0.0, pixel_thickness.x, mask.x);\n      float maskY = smoothstep(0.0, pixel_thickness.y, mask.y);\n      maskX = pow(maskX, .25);\n      maskY = pow(maskY, .25);\n      edge = clamp(1. - maskX * maskY, 0., 1.);\n    } else if (u_shape < 5.) {\n      // metaballs\n      vec2 shapeUV = uv - .5;\n      shapeUV *= 1.3;\n      edge = 0.;\n      for (int i = 0; i < 5; i++) {\n        float fi = float(i);\n        float speed = 1.5 + 2./3. * sin(fi * 12.345);\n        float angle = -fi * 1.5;\n        vec2 dir1 = vec2(cos(angle), sin(angle));\n        vec2 dir2 = vec2(cos(angle + 1.57), sin(angle + 1.));\n        vec2 traj = .4 * (dir1 * sin(t * speed + fi * 1.23) + dir2 * cos(t * (speed * 0.7) + fi * 2.17));\n        float d = length(shapeUV + traj);\n        edge += pow(1.0 - clamp(d, 0.0, 1.0), 4.0);\n      }\n      edge = 1. - smoothstep(.65, .9, edge);\n      edge = pow(edge, 4.);\n    }\n\n    edge = mix(smoothstep(.9 - 2. * fwidth(edge), .9, edge), edge, smoothstep(0.0, 0.4, u_contour));\n\n  }\n\n  float opacity = 0.;\n  if (u_isImage == true) {\n    opacity = img.g;\n    float frame = getImgFrame(v_imageUV, 0.);\n    opacity *= frame;\n  } else {\n    opacity = 1. - smoothstep(.9 - 2. * fwidth(edge), .9, edge);\n    if (u_shape < 2.) {\n      edge = 1.2 * edge;\n    } else if (u_shape < 5.) {\n      edge = 1.8 * pow(edge, 1.5);\n    }\n  }\n\n  float diagBLtoTR = rotatedUV.x - rotatedUV.y;\n  float diagTLtoBR = rotatedUV.x + rotatedUV.y;\n\n  vec3 color = vec3(0.);\n  vec3 color1 = vec3(.98, 0.98, 1.);\n  vec3 color2 = vec3(.1, .1, .1 + .1 * smoothstep(.7, 1.3, diagTLtoBR));\n  color2 = mix(color2, vec3(.62, .72, .82 + .06 * smoothstep(.7, 1.3, diagTLtoBR)), u_pale);\n\n  vec2 grad_uv = uv - .5;\n\n  float dist = length(grad_uv + vec2(0., .2 * diagBLtoTR));\n  grad_uv = rotate(grad_uv, (.25 - .2 * diagBLtoTR) * PI);\n  float direction = grad_uv.x;\n\n  float bump = pow(1.8 * dist, 1.2);\n  bump = 1. - bump;\n  bump *= pow(uv.y, .3);\n\n\n  float thin_strip_1_ratio = .12 / cycleWidth * (1. - .4 * bump);\n  float thin_strip_2_ratio = .07 / cycleWidth * (1. + .4 * bump);\n  float wide_strip_ratio = (1. - thin_strip_1_ratio - thin_strip_2_ratio);\n\n  float thin_strip_1_width = cycleWidth * thin_strip_1_ratio;\n  float thin_strip_2_width = cycleWidth * thin_strip_2_ratio;\n\n  float noise = snoise(uv - t);\n\n  edge += (1. - edge) * u_distortion * noise;\n\n  direction += diagBLtoTR;\n  float contour = 0.;\n  direction -= 2. * noise * diagBLtoTR * (smoothstep(0., 1., edge) * (1.0 - smoothstep(0., 1., edge)));\n  direction *= mix(1., 1. - edge, smoothstep(.5, 1., u_contour));\n  direction -= 1.7 * edge * smoothstep(.5, 1., u_contour);\n  direction += .2 * pow(u_contour, 4.) * (1.0 - smoothstep(0., 1., edge));\n\n  bump *= clamp(pow(uv.y, .1), .3, 1.);\n  direction *= (.1 + (1.1 - edge) * bump);\n\n  direction *= (.4 + .6 * (1.0 - smoothstep(.5, 1., edge)));\n  direction += .18 * (smoothstep(.1, .2, uv.y) * (1.0 - smoothstep(.2, .4, uv.y)));\n  direction += .03 * (smoothstep(.1, .2, 1. - uv.y) * (1.0 - smoothstep(.2, .4, 1. - uv.y)));\n\n  direction *= (.5 + .5 * pow(uv.y, 2.));\n  direction *= cycleWidth;\n  direction -= t;\n\n\n  float colorDispersion = (1. - bump);\n  colorDispersion = clamp(colorDispersion, 0., 1.);\n  float dispersionRed = colorDispersion;\n  dispersionRed += .03 * bump * noise;\n  dispersionRed += 5. * (smoothstep(-.1, .2, uv.y) * (1.0 - smoothstep(.1, .5, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, 1., bump)));\n  dispersionRed -= diagBLtoTR;\n\n  float dispersionBlue = colorDispersion;\n  dispersionBlue *= 1.3;\n  dispersionBlue += (smoothstep(0., .4, uv.y) * (1.0 - smoothstep(.1, .8, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, .8, bump)));\n  dispersionBlue -= .2 * edge;\n\n  dispersionRed *= (u_shiftRed / 20.);\n  dispersionBlue *= (u_shiftBlue / 20.);\n\n  float blur = 0.;\n  float rExtraBlur = 0.;\n  float gExtraBlur = 0.;\n  if (u_isImage == true) {\n    float softness = 0.05 * u_softness;\n    blur = softness + .5 * smoothstep(1., 10., u_repetition) * smoothstep(.0, 1., edge);\n    float smallCanvasT = 1.0 - smoothstep(100., 500., min(u_resolution.x, u_resolution.y));\n    blur += smallCanvasT * smoothstep(.0, 1., edge);\n    rExtraBlur = softness * (0.05 + .1 * (u_shiftRed / 20.) * bump);\n    gExtraBlur = softness * 0.05 / max(0.001, abs(1. - diagBLtoTR));\n  } else {\n    blur = u_softness / 15. + .3 * contour;\n  }\n\n  vec3 w = vec3(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);\n  w[1] -= .02 * smoothstep(.0, 1., edge + bump);\n  float stripe_r = fract(direction + dispersionRed);\n  float r = getColorChanges(color1.r, color2.r, stripe_r, w, blur + fwidth(stripe_r) + rExtraBlur, bump, u_colorTint.r);\n  float stripe_g = fract(direction);\n  float g = getColorChanges(color1.g, color2.g, stripe_g, w, blur + fwidth(stripe_g) + gExtraBlur, bump, u_colorTint.g);\n  float stripe_b = fract(direction - dispersionBlue);\n  float b = getColorChanges(color1.b, color2.b, stripe_b, w, blur + fwidth(stripe_b), bump, u_colorTint.b);\n\n  color = vec3(r, g, b);\n  color *= opacity;\n\n  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;\n  color = color + bgColor * (1. - opacity);\n  opacity = opacity + u_colorBack.a * (1. - opacity);\n\n  \n  color += 1. / 256. * (fract(sin(dot(.014 * gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453123) - .5);\n\n\n  fragColor = vec4(color, opacity);\n}\n";
const VERT = "#version 300 es\nprecision mediump float;\n\nlayout(location = 0) in vec4 a_position;\n\nuniform vec2 u_resolution;\nuniform float u_pixelRatio;\nuniform float u_imageAspectRatio;\nuniform float u_originX;\nuniform float u_originY;\nuniform float u_worldWidth;\nuniform float u_worldHeight;\nuniform float u_fit;\nuniform float u_scale;\nuniform float u_rotation;\nuniform float u_offsetX;\nuniform float u_offsetY;\n\nout vec2 v_objectUV;\nout vec2 v_objectBoxSize;\nout vec2 v_responsiveUV;\nout vec2 v_responsiveBoxGivenSize;\nout vec2 v_patternUV;\nout vec2 v_patternBoxSize;\nout vec2 v_imageUV;\n\nvec3 getBoxSize(float boxRatio, vec2 givenBoxSize) {\n  vec2 box = vec2(0.);\n  // fit = none\n  box.x = boxRatio * min(givenBoxSize.x / boxRatio, givenBoxSize.y);\n  float noFitBoxWidth = box.x;\n  if (u_fit == 1.) { // fit = contain\n    box.x = boxRatio * min(u_resolution.x / boxRatio, u_resolution.y);\n  } else if (u_fit == 2.) { // fit = cover\n    box.x = boxRatio * max(u_resolution.x / boxRatio, u_resolution.y);\n  }\n  box.y = box.x / boxRatio;\n  return vec3(box, noFitBoxWidth);\n}\n\nvoid main() {\n  gl_Position = a_position;\n\n  vec2 uv = gl_Position.xy * .5;\n  vec2 boxOrigin = vec2(.5 - u_originX, u_originY - .5);\n  vec2 givenBoxSize = vec2(u_worldWidth, u_worldHeight);\n  givenBoxSize = max(givenBoxSize, vec2(1.)) * u_pixelRatio;\n  float r = u_rotation * 3.14159265358979323846 / 180.;\n  mat2 graphicRotation = mat2(cos(r), sin(r), -sin(r), cos(r));\n  vec2 graphicOffset = vec2(-u_offsetX, u_offsetY);\n\n\n  // ===================================================\n\n  float fixedRatio = 1.;\n  vec2 fixedRatioBoxGivenSize = vec2(\n  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,\n  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y\n  );\n\n  v_objectBoxSize = getBoxSize(fixedRatio, fixedRatioBoxGivenSize).xy;\n  vec2 objectWorldScale = u_resolution.xy / v_objectBoxSize;\n\n  v_objectUV = uv;\n  v_objectUV *= objectWorldScale;\n  v_objectUV += boxOrigin * (objectWorldScale - 1.);\n  v_objectUV += graphicOffset;\n  v_objectUV /= u_scale;\n  v_objectUV = graphicRotation * v_objectUV;\n\n  // ===================================================\n\n  v_responsiveBoxGivenSize = vec2(\n  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,\n  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y\n  );\n  float responsiveRatio = v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;\n  vec2 responsiveBoxSize = getBoxSize(responsiveRatio, v_responsiveBoxGivenSize).xy;\n  vec2 responsiveBoxScale = u_resolution.xy / responsiveBoxSize;\n\n  #ifdef ADD_HELPERS\n  v_responsiveHelperBox = uv;\n  v_responsiveHelperBox *= responsiveBoxScale;\n  v_responsiveHelperBox += boxOrigin * (responsiveBoxScale - 1.);\n  #endif\n\n  v_responsiveUV = uv;\n  v_responsiveUV *= responsiveBoxScale;\n  v_responsiveUV += boxOrigin * (responsiveBoxScale - 1.);\n  v_responsiveUV += graphicOffset;\n  v_responsiveUV /= u_scale;\n  v_responsiveUV.x *= responsiveRatio;\n  v_responsiveUV = graphicRotation * v_responsiveUV;\n  v_responsiveUV.x /= responsiveRatio;\n\n  // ===================================================\n\n  float patternBoxRatio = givenBoxSize.x / givenBoxSize.y;\n  vec2 patternBoxGivenSize = vec2(\n  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,\n  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y\n  );\n  patternBoxRatio = patternBoxGivenSize.x / patternBoxGivenSize.y;\n\n  vec3 boxSizeData = getBoxSize(patternBoxRatio, patternBoxGivenSize);\n  v_patternBoxSize = boxSizeData.xy;\n  float patternBoxNoFitBoxWidth = boxSizeData.z;\n  vec2 patternBoxScale = u_resolution.xy / v_patternBoxSize;\n\n  v_patternUV = uv;\n  v_patternUV += graphicOffset / patternBoxScale;\n  v_patternUV += boxOrigin;\n  v_patternUV -= boxOrigin / patternBoxScale;\n  v_patternUV *= u_resolution.xy;\n  v_patternUV /= u_pixelRatio;\n  if (u_fit > 0.) {\n    v_patternUV *= (patternBoxNoFitBoxWidth / v_patternBoxSize.x);\n  }\n  v_patternUV /= u_scale;\n  v_patternUV = graphicRotation * v_patternUV;\n  v_patternUV += boxOrigin / patternBoxScale;\n  v_patternUV -= boxOrigin;\n  // x100 is a default multiplier between vertex and fragmant shaders\n  // we use it to avoid UV presision issues\n  v_patternUV *= .01;\n\n  // ===================================================\n\n  vec2 imageBoxSize;\n  if (u_fit == 1.) { // contain\n    imageBoxSize.x = min(u_resolution.x / u_imageAspectRatio, u_resolution.y) * u_imageAspectRatio;\n  } else if (u_fit == 2.) { // cover\n    imageBoxSize.x = max(u_resolution.x / u_imageAspectRatio, u_resolution.y) * u_imageAspectRatio;\n  } else {\n    imageBoxSize.x = min(10.0, 10.0 / u_imageAspectRatio * u_imageAspectRatio);\n  }\n  imageBoxSize.y = imageBoxSize.x / u_imageAspectRatio;\n  vec2 imageBoxScale = u_resolution.xy / imageBoxSize;\n\n  v_imageUV = uv;\n  v_imageUV *= imageBoxScale;\n  v_imageUV += boxOrigin * (imageBoxScale - 1.);\n  v_imageUV += graphicOffset;\n  v_imageUV /= u_scale;\n  v_imageUV.x *= u_imageAspectRatio;\n  v_imageUV = graphicRotation * v_imageUV;\n  v_imageUV.x /= u_imageAspectRatio;\n\n  v_imageUV += .5;\n  v_imageUV.y = 1. - v_imageUV.y;\n}";
const P    = {"colorBack": "#00000000", "colorTint": "#5892B8", "repetition": 2, "softness": 0.1, "shiftRed": 0.3, "shiftBlue": 0.3, "distortion": 0.07, "contour": 0.4, "angle": 70, "speed": 0.9, "scale": 0.6, "fit": "contain", "pale": 0.65};
/* ============================================================
   空尘 · 液态金属 —— 几何 + 场 + 着色器宿主

   和上一版最大的不同：**喂给着色器的不再是平面剪影**。

   上一版给 Liquid Metal 一张纯轮廓，它自己在里面解泊松方程算「离边缘多远」。
   那个场只知道轮廓 —— 厚度、截面圆角、莫比乌斯式的扭转，它全看不见，
   所以出来是一条平带子。

   这一版直接用**真实三维表面法线**算这个场：

       edge = 1 − |n · V|

   语义和原来一模一样（正对镜头 = 0，掠射/轮廓 = 1），
   所以**着色器不用改**，但它现在读到的是真的三维：
   金属条纹会裹住管体、扭转看得见、一股压过另一股时深度真的跳变。

   纹理的通道约定沿用原实现：
       R = edge 场（形体外 = 1）      G = 不透明度（形体外 = 0）
   ============================================================ */

/* ───────────────── 向量 ───────────────── */
const V = {
  n: v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; },
  x: (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]],
  a: (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
  s: (a, k) => [a[0]*k, a[1]*k, a[2]*k],
};
const clamp01 = x => x < 0 ? 0 : (x > 1 ? 1 : x);
const smoother = x => { x = clamp01(x); return x*x*x*(x*(x*6-15)+10); };
const eout = x => 1 - Math.pow(1 - clamp01(x), 3);

/* ───────────────── 曲线 ───────────────── */
/* 逐行对齐 core3d.py 的 c_tref2 / c_mob2 —— 两边必须是同一条曲线，
   否则实时版和离线导出会长得不一样 */

/* 三叶结族 T(2,3)。a 控制三叶张开，b 控制交叉处抬升（间隙全来自它）。
   只要 b ≥ 1.3，(a,b,s) 之间任意连续变化都是合法同痕 */
function cTref(a = 2.2, b = 1.6, s = 19.33) {
  return t => {
    const u = 2*Math.PI*t;
    const P = [s*(Math.sin(u) + a*Math.sin(2*u)),
               s*(Math.cos(u) - a*Math.cos(2*u)),
               s*(-b*Math.sin(3*u))];
    return [P, V.n(P)];
  };
}

/* 带宽律：按半径给宽 —— 三叶结的半径一圈正好 3 个极小（穿心）3 个极大（外圈） */
function radialW(fn, wOut = 1.76, power = 0.85, N = 220) {
  let lo = 1e9, hi = -1e9; const rs = [];
  for (let i = 0; i < N; i++) {
    const P = fn(i/N)[0], r = Math.hypot(P[0], P[1], P[2]);
    rs.push(r); if (r < lo) lo = r; if (r > hi) hi = r;
  }
  const span = (hi - lo) || 1;
  return t => {
    const P = fn(((t % 1) + 1) % 1)[0];
    const x = clamp01((Math.hypot(P[0], P[1], P[2]) - lo) / span);
    return 1 + (wOut - 1) * Math.pow(x, power);
  };
}
/* 描画未完成时首尾收成尖 —— 线是「画出来」的，不是被平切一刀 */
function tipTaper(t, p, tip = 0.11) {
  if (p >= 0.995) return 1;
  const ss = x => { x = clamp01(x); return x*x*x*(x*(x*6-15)+10); };
  const close = ss((p - 0.86) / 0.14);
  const f = ss(Math.min(1, (1-t)/tip)) * ss(Math.min(1, t/tip));
  return f + (1 - f) * close;
}
function traced(fn, p) { p = Math.max(1e-3, Math.min(1, p)); return t => fn(t * p); }

function makeView(ax, ay, az) {
  const ca = Math.cos(ax), sa = Math.sin(ax);
  const cb = Math.cos(ay), sb = Math.sin(ay);
  const cc = Math.cos(az), sc = Math.sin(az);
  return p => {
    const y1 = p[1]*ca - p[2]*sa, z1 = p[1]*sa + p[2]*ca;
    const x2 = p[0]*cb + z1*sb,   z2 = -p[0]*sb + z1*cb;
    return [x2*cc - y1*sc, x2*sc + y1*cc, z2];
  };
}

/* 整圈椭圆截面。不用胶囊 —— 胶囊上下是平的，平面上法线不变，
   场里就出现一大片死板的平区；椭圆的法线沿周长连续转，场平滑爬升 */
function ellipseProfile(hw, ht, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = 2*Math.PI*i/n;
    const nu = ht*Math.sin(a), nv = hw*Math.cos(a);
    const L = Math.hypot(nu, nv) || 1;
    out.push([hw*Math.sin(a), ht*Math.cos(a), nu/L, nv/L]);
  }
  return out;
}

/* ───────────────── 场 ───────────────── */
/* 以「站」为单位组织：每站带中轴深度、屏幕上的两条外缘、各小面的 edge 值。
   交叉断口靠站与站之间的深度差 —— 画家算法逐站铺过去就自然出现 */
/* ───────────────── 表面波纹 ───────────────── */
/* 一列沿着带子走的行波。做法不是「画上去的波纹」，而是**扰动表面法线** ——
   因为场就是 edge = 1 − |n·V|，法线一动，金属条纹就跟着起伏。

   波形 h = sin(φ)，而法线的倾斜量正比于 h 沿表面的**导数**，所以用 cos(φ)：
       n' = n + 幅度 · cos(φ) · T        沿长度方向的倾斜
              + 幅度 · cos(φ) · ŝ        绕截面方向的倾斜
   同时把截面半径按 sin(φ) 微微起伏，让**轮廓本身**也跟着波动。

   φ = 2π (KT·t + KP·u − 相位)  ——  相位推进 1 就回到原样，所以能**无缝循环**。 */
/* 倾斜量取得比「物理导数」大不少：edge = 1 − |n·V| 在正对镜头处对倾斜
   **极不敏感**（cos 在 0 附近是二阶平的），轻微扰动只在轮廓附近看得见，
   带子中间一动不动。所以放大系数，让波纹在整条带上都读得出来。 */
/* DISP = 0 是**刻意的**：它原本会推动截面半径，让轮廓跟着起伏 ——
   那就等于改了形，和定稿对不上。现在波纹只作用在法线上：
   **轮廓逐像素不变，动的只有表面。** */
const RIPPLE = { KT: 14.0, KP: 1.0, DISP: 0.0, TILT_T: 2.50, TILT_P: 0.65 };

function stations(fn, rv, o) {
  const N = o.N, nsec = o.nsec, frames = [];
  const rA = o.rAmp || 0, rP = o.rPhase || 0;
  for (let i = 0; i <= N; i++) {
    const t = i/N;
    const [P, Nr0] = fn(t);
    const Pn = fn((t + 0.0008) % 1)[0];
    const T = V.n([Pn[0]-P[0], Pn[1]-P[1], Pn[2]-P[2]]);
    let Nr = V.n(Nr0), B = V.n(V.x(T, Nr)); Nr = V.n(V.x(B, T));
    if (o.twist) {
      const ph = 2*Math.PI*o.twist*t, c = Math.cos(ph), s = Math.sin(ph);
      const nN = V.a(V.s(Nr, c), V.s(B, s));
      const nB = V.a(V.s(Nr, -s), V.s(B, c));
      Nr = nN; B = nB;
    }
    const hw = (o.wfn ? o.wfn(t) : 1) * o.W/2 * tipTaper(t, o.p);
    frames.push([P, Nr, B, T, hw, o.TH/2]);
  }
  const prof = [], rim = [], cen = [];
  frames.forEach(([P, Nr, B, T, hw, ht], fi) => {
    const tt = fi / N;
    const pr = ellipseProfile(hw, ht, nsec);
    if (rA) {                                  // 轮廓也跟着起伏
      for (let j = 0; j < pr.length; j++) {
        const ph = 2*Math.PI*(RIPPLE.KT*tt + RIPPLE.KP*(j/pr.length) - rP);
        const k = 1 + RIPPLE.DISP*rA*Math.sin(ph);
        pr[j] = [pr[j][0]*k, pr[j][1]*k, pr[j][2], pr[j][3]];
      }
    }
    const p2 = pr.map(q => rv(V.a(P, V.a(V.s(B, q[0]), V.s(Nr, q[1])))));
    const c = rv(P), t2 = rv(T), b2 = rv(B), n2 = rv(Nr);
    const dl = Math.hypot(t2[0], t2[1]) || 1;
    const dx = -t2[1]/dl, dy = t2[0]/dl;
    /* 外缘取**解析解**，不是「投影点里最靠外的那一个」。
       取顶点会在相邻站之间跳格，擦出来的断口带就是锯齿状的。
       截面是椭圆，投影后沿 d 的半幅正好有闭式解： */
    const A = Math.hypot(hw*(b2[0]*dx + b2[1]*dy), ht*(n2[0]*dx + n2[1]*dy));
    prof.push([pr, p2]);
    rim.push([[c[0] - A*dx, c[1] - A*dy], [c[0] + A*dx, c[1] + A*dy]]);
    cen.push(c);
  });
  const out = [];
  for (let i = 0; i < N; i++) {
    const [pr0, pt0] = prof[i], pt1 = prof[i+1][1];
    const [, N0, B0, T0] = frames[i];
    const M = pr0.length, faces = [];
    for (let j = 0; j < M; j++) {
      const k = (j+1) % M;
      const nu = (pr0[j][2] + pr0[k][2]) / 2, nv = (pr0[j][3] + pr0[k][3]) / 2;
      const L = Math.hypot(nu, nv) || 1;
      let wn = V.a(V.s(B0, nu/L), V.s(N0, nv/L));
      if (rA) {
        const ph = 2*Math.PI*(RIPPLE.KT*(i/N) + RIPPLE.KP*((j+0.5)/M) - rP);
        const cw = Math.cos(ph);
        // ŝ：截面切向（法线转 90°），给绕圈方向的那一半倾斜
        const sB = -nv/L, sN = nu/L;
        wn = V.n(V.a(wn, V.a(V.s(T0, rA*RIPPLE.TILT_T*cw),
                             V.s(V.a(V.s(B0, sB), V.s(N0, sN)), rA*RIPPLE.TILT_P*cw))));
      }
      const nv3 = rv(wn), ln = Math.hypot(nv3[0], nv3[1], nv3[2]) || 1;
      const edge = 1 - Math.abs(nv3[2]/ln);        // ← 立体感全部来自这里
      const a = pt0[j], b = pt0[k], c = pt1[k], d = pt1[j];
      faces.push([(a[2]+b[2]+c[2]+d[2])/4, [a, b, c, d], edge]);
    }
    faces.sort((x, y) => x[0] - y[0]);
    out.push([(cen[i][2] + cen[i+1][2])/2, [rim[i], rim[i+1]], faces]);
  }
  out.sort((x, y) => x[0] - y[0]);                 // 远 → 近
  return out;
}

/* 画到 canvas。全程不透明 —— 通道约定是 R=场 / G=不透明度，
   不靠 canvas 的 alpha（canvas 会预乘，透明像素读回来 R 一定是 0，
   那样着色器在轮廓外侧读到的就不是 1，边缘的高光会塌掉） */
function paintField(ctx, st, S, fill, gap, alpha) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgb(255,0,0)';                  // 形体外：场 = 1，不透明度 = 0
  ctx.fillRect(0, 0, S, S);

  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [, , fs] of st) for (const [, q] of fs) for (const v of q) {
    if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0];
    if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1];
  }
  const span = Math.max(x1-x0, y1-y0) || 1;
  const k = S * fill / span, cx = (x0+x1)/2, cy = (y0+y1)/2;
  const PX = v => S/2 + (v[0]-cx)*k, PY = v => S/2 + (v[1]-cy)*k;

  const ga = Math.round(255 * clamp01(alpha));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  for (const [, rims, faces] of st) {
    /* 断口：擦掉外缘**往外**的一条带，不往里擦。
       往里擦会出锯齿 —— 相邻站的外缘几乎共线，后画的那一站会把前一站
       靠边的一小块削掉，而它自己的面又补不回来，一站一个缺口就成了锯齿。
       把整条擦除带推到轮廓外侧，就只会切到「后面那一股」，切不到自己。 */
    ctx.strokeStyle = 'rgb(255,0,0)';
    ctx.lineWidth = gap * 2;
    ctx.beginPath();
    for (const e of [0, 1]) {
      const pts = [0, 1].map(i => {
        const r = rims[i][e], m = rims[i];
        const mx = (m[0][0]+m[1][0])/2, my = (m[0][1]+m[1][1])/2;
        let ox = PX(r) - PX([mx, my]), oy = PY(r) - PY([mx, my]);
        const l = Math.hypot(ox, oy) || 1;
        return [PX(r) + ox/l*gap, PY(r) + oy/l*gap];
      });
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
    }
    ctx.stroke();
    for (const [, q, edge] of faces) {
      const c = 'rgb(' + Math.round(255*clamp01(edge)) + ',' + ga + ',255)';
      ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PX(q[0]), PY(q[0]));
      for (let i = 1; i < 4; i++) ctx.lineTo(PX(q[i]), PY(q[i]));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
}

/* ───────────────── 形的定义 + 成形动画时间轴 ───────────────── */
/* 时间轴沿用 v6 那条：暗 → 描画 → 收紧 → 定格。
   （莫比乌斯已弃用，这一轮只做三叶结） */
const T_DARK = 0.40, T_TRACE = 1.70, T_TIGHT = 2.45, T_SET = 3.20;
/* 滑块右端 = 导出动画的全长。两边帧号必须一一对应，
   否则你在页面上挑的「第 N 帧」在 MP4 里根本不是同一帧。 */
const T_MAX  = 7.00;
const T_HOLD = 2.90;                       // 定格时刻 —— final12.py 的 LOCK_T
const RIP_LOOP = 4.5;                      // 波纹一轮的秒数（和离线导出一致）

const SHAPE = {
  N: 170, nsec: 28, W: 11.5, TH: 7.0, twist: 0.5,
  // 定格视角 —— 你在拖拽版里挑的那一组，这一版锁死在这里
  view: [1.926, -0.148, 0.000], fill: 0.80, gap: 13, rAmp: 0.0,   /* 默认关 —— 打开就是定版 */
  at(el) {
    const q = smoother((el - T_TRACE) / (T_TIGHT - T_TRACE));
    // 收紧：在三叶结自己的参数族内变形 —— 同痕，不会穿过自身
    const fn = cTref(2.2, 2.60 + (1.60-2.60)*q, 17.60 + (19.33-17.60)*q);
    return { fn, wfn: radialW(fn, 1.76) };
  }
};

/* 某一时刻的完整状态。
   view 传进来是**定格视角** —— 拖动画面就是在改它，
   成形动画仍然从侧后方转进来，只是落定到你选的这个角度。 */
function stateAt(el, view, nMax) {
  const p = smoother((el - T_DARK) / (T_TRACE - T_DARK));
  const { fn, wfn } = SHAPE.at(el);
  const alpha = clamp01((el - T_DARK + 0.06) / 0.40);
  const ease = eout(clamp01((el - 0.35) / 2.35));
  const ax = view[0] + (-0.10 - view[0]) * (1 - ease);
  const ay = view[1] + (1 - ease) * 4.2;    // 转进来，再落定
  return {
    p, alpha,
    rv: makeView(ax, ay, view[2]),
    fn: traced(fn, p),
    wfn: t => wfn(t * p),
    N: Math.max(6, Math.round((nMax || SHAPE.N) * Math.max(p, 0.06)))
  };
}

function fieldAt(ctx, el, S, view, rAmp, rPhase, nMax) {
  const s = stateAt(el, view || SHAPE.view, nMax);
  if (s.p <= 0.015) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgb(255,0,0)'; ctx.fillRect(0, 0, S, S);
    return;
  }
  const st = stations(s.fn, s.rv, {
    N: s.N, nsec: SHAPE.nsec, W: SHAPE.W, TH: SHAPE.TH,
    twist: SHAPE.twist * s.p, wfn: s.wfn, p: s.p,
    rAmp: rAmp === undefined ? SHAPE.rAmp : rAmp,
    rPhase: rPhase === undefined ? 0 : rPhase
  });
  paintField(ctx, st, S, SHAPE.fill, SHAPE.gap, s.alpha);
}


/* ───────────────── WebGL 宿主 ───────────────── */
function hex4(c){
  let h=c.replace('#',''); if(h.length===3) h=h.split('').map(x=>x+x).join('');
  if(h.length===6) h+='ff';
  return [0,2,4,6].map(i=>parseInt(h.slice(i,i+2),16)/255);
}
function compile(gl,type,src){
  const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const FIELD = 720;
/* 两块画的是同一个形、同一个视角 —— 场只算一次，两个纹理共用 */
const SHARED = document.createElement('canvas');
SHARED.width = SHARED.height = FIELD;
const SCTX = SHARED.getContext('2d', {alpha:false});

class Metal{
  constructor(canvas){
    this.canvas=canvas;
    const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false});
    if(!gl) throw new Error('no webgl2');
    this.gl=gl;
    const p=gl.createProgram();
    gl.attachShader(p,compile(gl,gl.VERTEX_SHADER,VERT));
    gl.attachShader(p,compile(gl,gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p=p; gl.useProgram(p);

    const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);

    this.tex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,SHARED);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);

    this.u={}; const n=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);
    for(let i=0;i<n;i++){const q=gl.getActiveUniform(p,i); this.u[q.name]=gl.getUniformLocation(p,q.name);}
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    this.tint=P.colorTint; this.pale=P.pale; this.t=0;
    this.resize(); this.setStatic();
  }
  set1(n,v){ if(this.u[n]) this.gl.uniform1f(this.u[n],v); }
  setStatic(){
    const gl=this.gl; gl.useProgram(this.p);
    gl.uniform1i(this.u.u_image,0);
    gl.uniform4f(this.u.u_colorBack,...hex4(P.colorBack));
    gl.uniform4f(this.u.u_colorTint,...hex4(this.tint));
    this.set1('u_softness',P.softness); this.set1('u_repetition',P.repetition);
    this.set1('u_shiftRed',P.shiftRed); this.set1('u_shiftBlue',P.shiftBlue);
    this.set1('u_distortion',P.distortion); this.set1('u_contour',P.contour);
    this.set1('u_angle',P.angle); this.set1('u_pale',this.pale);
    if(this.u.u_isImage) gl.uniform1i(this.u.u_isImage,1);
    this.set1('u_shape',3); this.set1('u_fit',1); this.set1('u_scale',P.scale);
    this.set1('u_rotation',0); this.set1('u_offsetX',0); this.set1('u_offsetY',0);
    this.set1('u_originX',0.5); this.set1('u_originY',0.5);
    this.set1('u_worldWidth',0); this.set1('u_worldHeight',0);
    this.set1('u_imageAspectRatio',1);
  }
  setTint(c){ this.tint=c; this.gl.useProgram(this.p);
    this.gl.uniform4f(this.u.u_colorTint,...hex4(c)); }
  setPale(v){ this.pale=v; this.gl.useProgram(this.p); this.set1('u_pale',v); }
  resize(){
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const w=Math.round(this.canvas.clientWidth*dpr), h=Math.round(this.canvas.clientHeight*dpr);
    if(!w||!h) return;
    this.canvas.width=w; this.canvas.height=h;
    this.gl.viewport(0,0,w,h); this.gl.useProgram(this.p);
    this.gl.uniform2f(this.u.u_resolution,w,h);
    this.set1('u_pixelRatio',dpr);
  }
  upload(){
    const gl=this.gl;
    gl.bindTexture(gl.TEXTURE_2D,this.tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,SHARED);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  draw(t){
    const gl=this.gl; gl.useProgram(this.p);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.tex);
    this.set1('u_time',t*P.speed);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
}


/* ───────────────── 首页用的封装 ───────────────── */

/* 渲染分辨率全程锁死。
   着色器里 `smallCanvasT = 1 - smoothstep(100., 500., min(u_resolution))`
   会在小画布上额外加一层模糊 —— 分辨率一变材质就变，所以不能跟着
   CSS 尺寸走（首页的 logo 会从 250px 缩到 64px）。
   524 是定版页面 262px × dpr2 的实际缓冲尺寸，取 512 与之同档。 */
const RENDER = 512;

/* 几何和镜头在 el ≥ 2.70 之后完全静止：
     形    p = smoother((el-0.40)/1.30)      → 1.70 描画完
     收紧  q = smoother((el-1.70)/0.75)      → 2.45 收紧完
     镜头  ease = eout((el-0.35)/2.35)       → 2.70 落定
   之后只有金属条纹还在走，所以从这一刻起停掉「重算几何 + 重传纹理」，
   每帧只剩一次 draw —— 常驻期的开销主要就省在这里。 */
const T_FROZEN = 2.70;

export const TIMELINE = { DARK: T_DARK, TRACE: T_TRACE, TIGHT: T_TIGHT, SET: T_SET, HOLD: T_HOLD, FROZEN: T_FROZEN };

export function createMark(canvas) {
  const metal = new Metal(canvas);           // WebGL2 不可用会在这里抛，调用方负责兜底

  canvas.width = canvas.height = RENDER;
  const gl = metal.gl;
  gl.viewport(0, 0, RENDER, RENDER);
  gl.useProgram(metal.p);
  gl.uniform2f(metal.u.u_resolution, RENDER, RENDER);
  metal.set1('u_pixelRatio', 1);
  metal.resize = () => {};                   // 尺寸锁死，别让 resize 把它改回去

  let builtAt = -1;                          // 上一次真正重算几何的时刻

  return {
    /* 画 el 时刻的一帧。几何冻结之后自动省掉场的重算与上传。
       nMax 只影响成形途中的站数，落定帧永远用完整的 SHAPE.N */
    draw(el, nMax) {
      const shaped = Math.min(el, T_FROZEN);
      if (builtAt !== shaped) {
        fieldAt(SCTX, shaped, FIELD, SHAPE.view, 0, 0, shaped < T_FROZEN ? nMax : SHAPE.N);
        metal.upload();
        builtAt = shaped;
      }
      metal.draw(el);                        // u_time 用真实 el —— 金属一直流
    },
    /* 重播：下一次 draw 必须重算 */
    reset() { builtAt = -1; },
  };
}
