// Is this graphics driver the processor drawing in software? Isomorphic: the desktop app's
// verdict (desktop/graphics.mjs) and the TV page's automatic lighter effects both ask, from the
// WebGL renderer string (WEBGL_debug_renderer_info), e.g. "ANGLE (Mesa, llvmpipe (LLVM 17.0.6,
// 256 bits), OpenGL 4.5)" or "SwiftShader Device".

export const SOFTWARE_RENDERER = /llvmpipe|softpipe|swiftshader|software|lavapipe|basic render/i;

export function isSoftwareRenderer(name) {
  return SOFTWARE_RENDERER.test(String(name || ''));
}
