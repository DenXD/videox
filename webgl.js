// Shader-based renderer used by "Enhanced" mode. Does the colour math in
// float precision and dithers on output, which removes the banding the 8-bit
// CSS/SVG filter pipeline produces on dark scenes.

const VIXDIO_VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Matrices mirror the Filter Effects spec so both modes look identical at
// equal settings; only precision and dithering differ.
const VIXDIO_FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform float u_gamma;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue;
varying vec2 v_uv;

vec3 hueRotate(vec3 c, float deg) {
  float a = radians(deg);
  float s = sin(a);
  float o = cos(a);
  mat3 m = mat3(
    0.213 + o * 0.787 - s * 0.213, 0.213 - o * 0.213 + s * 0.143, 0.213 - o * 0.213 - s * 0.787,
    0.715 - o * 0.715 - s * 0.715, 0.715 + o * 0.285 + s * 0.140, 0.715 - o * 0.715 + s * 0.715,
    0.072 - o * 0.072 + s * 0.928, 0.072 - o * 0.072 - s * 0.283, 0.072 + o * 0.928 + s * 0.072
  );
  return m * c;
}

float dither(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  c = pow(max(c, 0.0), vec3(1.0 / u_gamma));
  c *= u_brightness;
  c = (c - 0.5) * u_contrast + 0.5;
  c = mix(vec3(dot(c, vec3(0.213, 0.715, 0.072))), c, u_saturation);
  if (u_hue != 0.0) c = hueRotate(c, u_hue);
  c += (dither(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Frame counts at which we sample the output looking for protected (all-black)
// content. Spread out so a legitimate fade-in from black isn't mistaken for it.
const VIXDIO_BLACK_CHECKS = [30, 90, 180];

class VixdioRenderer {
  constructor(video, settings, onFallback) {
    this.video = video;
    this.settings = settings;
    this.onFallback = onFallback;
    this.destroyed = false;
    this.frames = 0;
    this.blackHits = 0;
    this.handle = null;
    this.usingFrameCallback = false;
  }

  start() {
    const video = this.video;
    const parent = video.parentElement;
    if (!parent) return false;

    const canvas = document.createElement('canvas');
    canvas.className = 'vixdio-canvas';
    canvas.style.cssText =
      'position:absolute;pointer-events:none;margin:0;padding:0;border:0;background:#000';

    const gl =
      canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
      }) || null;
    if (!gl) return false;

    this.canvas = canvas;
    this.gl = gl;

    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
      this.parentPositioned = parent;
    }

    if (!this.initGL()) return false;

    video.after(canvas);
    this.prevOpacity = video.style.opacity;
    video.style.opacity = '0';
    video.style.filter = '';

    this.resizeObserver = new ResizeObserver(() => this.sync());
    this.resizeObserver.observe(video);
    this.sync();

    this.usingFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    this.loop();
    return true;
  }

  initGL() {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VIXDIO_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, VIXDIO_FRAG);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    this.program = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      gamma: gl.getUniformLocation(prog, 'u_gamma'),
      brightness: gl.getUniformLocation(prog, 'u_brightness'),
      contrast: gl.getUniformLocation(prog, 'u_contrast'),
      saturation: gl.getUniformLocation(prog, 'u_saturation'),
      hue: gl.getUniformLocation(prog, 'u_hue'),
    };

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return true;
  }

  update(settings) {
    this.settings = settings;
  }

  sync() {
    if (this.destroyed) return;
    const v = this.video;
    const cw = v.clientWidth;
    const ch = v.clientHeight;
    if (!cw || !ch) return;

    // The element box can have a different aspect ratio than the video frame
    // (theater mode, 4:3 content in a 16:9 player) — the browser letterboxes
    // the picture inside it. Match the canvas to the drawn picture, not the
    // element, or the frame gets stretched.
    let x = v.offsetLeft;
    let y = v.offsetTop;
    let w = cw;
    let h = ch;
    if (v.videoWidth && v.videoHeight) {
      const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
      w = Math.max(1, Math.round(v.videoWidth * scale));
      h = Math.max(1, Math.round(v.videoHeight * scale));
      x += Math.round((cw - w) / 2);
      y += Math.round((ch - h) / 2);
    }

    this.lastLeft = v.offsetLeft;
    this.lastTop = v.offsetTop;
    this.lastVideoW = v.videoWidth;
    this.canvas.style.left = `${x}px`;
    this.canvas.style.top = `${y}px`;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // Never render above the source resolution — upscaling costs GPU time
    // and adds nothing.
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.min(Math.round(w * dpr), v.videoWidth || Math.round(w * dpr)));
    const bh = Math.max(1, Math.min(Math.round(h * dpr), v.videoHeight || Math.round(h * dpr)));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  loop() {
    if (this.destroyed) return;
    this.draw();
    if (this.usingFrameCallback) {
      this.handle = this.video.requestVideoFrameCallback(() => this.loop());
    } else {
      this.handle = requestAnimationFrame(() => this.loop());
    }
  }

  draw() {
    const { gl, video, settings } = this;
    if (!video.isConnected) {
      this.fallback('detached');
      return;
    }
    // Sites like YouTube rebuild the player DOM after we attach, silently
    // dropping the canvas (or resetting the video's inline style). Without
    // this the video stays hidden while the canvas draws into nowhere —
    // black picture, audio still playing. Re-anchor and re-assert each frame.
    if (this.canvas.parentElement !== video.parentElement) {
      video.after(this.canvas);
      const parent = video.parentElement;
      if (parent && getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
        this.parentPositioned = parent;
      }
      this.sync();
    }
    if (video.style.opacity !== '0') video.style.opacity = '0';
    if (
      video.offsetLeft !== this.lastLeft ||
      video.offsetTop !== this.lastTop ||
      video.videoWidth !== this.lastVideoW
    ) {
      this.sync();
    }
    if (video.readyState < 2) return;

    try {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      // Cross-origin media without CORS headers taints the source.
      this.fallback('cors');
      return;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.gamma, settings.gamma);
    gl.uniform1f(this.uniforms.brightness, settings.brightness / 100);
    gl.uniform1f(this.uniforms.contrast, settings.contrast / 100);
    gl.uniform1f(this.uniforms.saturation, settings.saturation / 100);
    gl.uniform1f(this.uniforms.hue, settings.hue);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.frames++;
    if (VIXDIO_BLACK_CHECKS.includes(this.frames) && !video.paused) {
      if (this.isAllBlack()) {
        this.blackHits++;
        if (this.blackHits === VIXDIO_BLACK_CHECKS.length) this.fallback('protected');
      } else {
        this.blackHits = 0;
      }
    }
  }

  // DRM-protected frames read back as pure black. Real content practically
  // always carries some compression noise, so an exact-zero grid means the
  // decoder never handed us the picture.
  isAllBlack() {
    const gl = this.gl;
    const px = new Uint8Array(4);
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (let i = 1; i <= 4; i++) {
      for (let j = 1; j <= 4; j++) {
        const x = Math.floor((w * i) / 5);
        const y = Math.floor((h * j) / 5);
        try {
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        } catch (e) {
          return true;
        }
        if (px[0] || px[1] || px[2]) return false;
      }
    }
    return true;
  }

  fallback(reason) {
    if (this.destroyed) return;
    this.destroy();
    if (this.onFallback) this.onFallback(reason);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.handle !== null) {
      if (this.usingFrameCallback && this.video.cancelVideoFrameCallback) {
        this.video.cancelVideoFrameCallback(this.handle);
      } else if (!this.usingFrameCallback) {
        cancelAnimationFrame(this.handle);
      }
    }
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.canvas) this.canvas.remove();
    if (this.parentPositioned) this.parentPositioned.style.position = '';
    this.video.style.opacity = this.prevOpacity || '';

    const gl = this.gl;
    if (gl) {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
    this.gl = null;
  }
}
