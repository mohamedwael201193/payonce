// Our own sky and clouds: a procedural WebGL fragment shader (layered value-noise
// fbm, lit from the upper left). No image, no video pixels. Mode "back" paints the
// red-orange sky and the rear cloud bank; mode "front" paints a transparent front
// bank that overlaps the product panel so it sinks into the clouds.
//
// Budget: rendered at a fraction of CSS resolution (clouds are soft), ~30 fps,
// paused off-screen and when the tab is hidden, one static frame under reduced
// motion, and a plain CSS gradient (set on the parent) when WebGL is missing.
import { useEffect, useRef } from 'react'

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform vec2 uCss;
uniform float uTime;
uniform float uMode;
uniform float uBank;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++){ v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

// Cloud density at css point q (y up from the bottom edge). >0.5 inside a cloud.
float dens(vec2 q, float bankH, float scale, float seed, float lift){
  float hy = q.y / bankH;
  vec2 o = vec2(uTime * 0.06 * (1.0 + seed * 0.2) + seed * 7.3, seed * 3.1);
  float n = fbm(q / scale + o);
  float b = abs(noise(q / (scale * 0.55) + o * 1.3 + 4.0) - 0.5) * 2.0;
  float cauli = fbm(q / (scale * 0.3) + vec2(seed * 11.0, uTime * 0.03)) * 0.2;
  return n * 0.95 + (1.0 - b) * 0.16 + cauli + lift - hy * 0.95;
}

// Lit cloud: rgb in xyz, alpha in w. Light comes from the upper left.
vec4 cloud(vec2 q, float bankH, float scale, float seed, float lift, vec3 warm, float soft){
  float d = dens(q, bankH, scale, seed, lift);
  float a = smoothstep(0.5 - soft, 0.5 + soft * 0.6, d);
  if (a <= 0.001) return vec4(0.0);
  float dl = dens(q + vec2(-scale * 0.05, scale * 0.085), bankH, scale, seed, lift);
  float shade = clamp((dl - d) * 6.5 + 0.24, 0.0, 1.0);
  float depth = clamp((d - 0.5) * 2.2, 0.0, 1.0);
  float hy = clamp(q.y / bankH, 0.0, 1.0);
  vec3 lit = vec3(1.0, 0.99, 0.975);
  vec3 mid = vec3(1.0, 0.80, 0.60);
  vec3 shadow = mix(vec3(0.95, 0.56, 0.34), warm, 0.3);
  vec3 c = mix(lit, mid, clamp(shade * 0.9 + (1.0 - hy) * 0.1, 0.0, 1.0));
  c = mix(c, shadow, clamp(shade * shade * 0.95 + depth * 0.2 * (1.0 - hy), 0.0, 0.85));
  return vec4(c, a);
}

void main(){
  vec2 q = gl_FragCoord.xy / uRes * uCss;
  float H = uCss.y;
  float W = uCss.x;
  vec3 paper = vec3(0.937, 0.929, 0.894);
  float fade = smoothstep(150.0, 12.0, q.y);

  if (uMode > 0.5) {
    // Front bank: transparent above, paper at the very bottom.
    vec4 f1 = cloud(q + vec2(0.0, -10.0), uBank, 260.0, 5.0, 0.42, vec3(1.0, 0.78, 0.6), 0.07);
    vec4 f2 = cloud(q + vec2(240.0, -36.0), uBank * 0.8, 200.0, 9.0, 0.34, vec3(1.0, 0.82, 0.66), 0.07);
    vec3 col = vec3(0.0);
    float a = 0.0;
    col = f2.rgb * f2.a; a = f2.a;
    col = f1.rgb * f1.a + col * (1.0 - f1.a); a = f1.a + a * (1.0 - f1.a);
    col = mix(col, paper * a, fade * 0.0);
    // Paper wash: converts to opaque paper at the bottom so the section joins seamlessly.
    float wash = smoothstep(120.0, 8.0, q.y);
    col = col * (1.0 - wash) + paper * wash;
    a = a * (1.0 - wash) + wash;
    gl_FragColor = vec4(col, a);
    return;
  }

  // Sky
  float sky = clamp((H - q.y) / max(H - uBank * 0.55, 1.0), 0.0, 1.0);
  vec3 c0 = vec3(0.800, 0.125, 0.0);
  vec3 c1 = vec3(0.906, 0.165, 0.0);
  vec3 c2 = vec3(0.969, 0.345, 0.035);
  vec3 c3 = vec3(0.980, 0.545, 0.215);
  vec3 c4 = vec3(0.965, 0.690, 0.470);
  vec3 col = mix(c0, c1, smoothstep(0.0, 0.3, sky));
  col = mix(col, c2, smoothstep(0.26, 0.55, sky));
  col = mix(col, c3, smoothstep(0.5, 0.82, sky));
  col = mix(col, c4, smoothstep(0.8, 1.0, sky));

  // Painterly horizontal streaks.
  float st = fbm(vec2(q.x / 1000.0, q.y / 150.0) + vec2(uTime * 0.018, 2.0));
  float st2 = fbm(vec2(q.x / 480.0, q.y / 90.0) + vec2(-uTime * 0.03, 9.0));
  col += (st - 0.5) * vec3(0.17, 0.16, 0.05) + (st2 - 0.5) * vec3(0.07, 0.06, 0.02);

  // Warm light patch on the left.
  vec2 g = (q - vec2(W * 0.1, H * 0.5)) / vec2(W * 0.55, H * 0.32);
  col = mix(col, vec3(0.99, 0.60, 0.26), exp(-dot(g, g)) * 0.34);

  // Mid-sky wisps toward the horizon.
  float w = fbm(q / 250.0 + vec2(uTime * 0.05, 8.0));
  float wm = smoothstep(0.52, 0.8, w) * smoothstep(0.3, 0.85, sky) * 0.5;
  col = mix(col, vec3(1.0, 0.80, 0.62), wm);

  // Banks rise higher toward the left and right edges so the centre stays open for the panel.
  float side = pow(abs(q.x / W - 0.5) * 2.0, 1.5) * 0.4;
  // Rear bank (smaller, warmer) then near bank.
  vec4 far = cloud(q + vec2(0.0, -uBank * 0.12), uBank * 1.15, 210.0, 2.0, 0.36 + side, vec3(1.0, 0.62, 0.34), 0.09);
  col = mix(col, far.rgb, far.a * 0.92);
  vec4 near = cloud(q + vec2(-130.0, 0.0), uBank, 290.0, 4.0, 0.42 + side, vec3(1.0, 0.72, 0.5), 0.07);
  col = mix(col, near.rgb, near.a);

  col = mix(col, paper, fade);
  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error(`cloud shader: ${log}`)
  }
  return s
}

export function Clouds({ mode, bank, className }: { mode: 'back' | 'front'; bank: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return
    const gl = cv.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' })
    if (!gl) return
    let prog: WebGLProgram
    try {
      prog = gl.createProgram()!
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
    } catch {
      return
    }
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uCss = gl.getUniformLocation(prog, 'uCss')
    const uTime = gl.getUniformLocation(prog, 'uTime')
    const uMode = gl.getUniformLocation(prog, 'uMode')
    const uBank = gl.getUniformLocation(prog, 'uBank')

    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const touch = matchMedia('(pointer: coarse)').matches
    const scale = touch ? 0.42 : 0.55
    let cssW = 0
    let cssH = 0
    let visible = true
    let raf = 0
    let last = 0
    const t0 = performance.now()

    const draw = (now: number) => {
      if (!cssW || !cssH) return
      gl.uniform1f(uTime, still ? 9 : 9 + (now - t0) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const resize = () => {
      const r = cv.getBoundingClientRect()
      cssW = Math.max(1, r.width)
      cssH = Math.max(1, r.height)
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const k = Math.min(dpr, 1.5) * scale
      cv.width = Math.max(2, Math.round(cssW * k))
      cv.height = Math.max(2, Math.round(cssH * k))
      gl.viewport(0, 0, cv.width, cv.height)
      gl.uniform2f(uRes, cv.width, cv.height)
      gl.uniform2f(uCss, cssW, cssH)
      gl.uniform1f(uMode, mode === 'front' ? 1 : 0)
      gl.uniform1f(uBank, bank)
      draw(performance.now())
    }
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (!visible || document.hidden) return
      if (now - last < 33) return
      last = now
      draw(now)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    resize()
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
    })
    io.observe(cv)
    if (!still) raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [mode, bank])

  return <canvas ref={ref} className={className} aria-hidden />
}
