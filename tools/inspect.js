// Debug helper loaded from the console: flat clay shading for any mesh, so shapes
// that sit in shadow (the seated player's jacket) can be inspected.
//   const s = await import('/tools/inspect.js'); s.clay(nim.player.torso, ...)
export function clayMaterial(THREE, tint = 1) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uTint: { value: tint } },
    vertexShader: `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vN; varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTint; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 N = normalize(vN);
        if (!gl_FrontFacing) N = -N;
        float k = 0.18 + 0.62 * max(dot(N, normalize(vec3(0.4, 0.8, 0.45))), 0.0) + 0.2 * max(dot(N, normalize(vec3(-0.6, 0.2, -0.7))), 0.0);
        vec3 c = vec3(k) * uTint;
        if (!gl_FrontFacing) c = vec3(0.9, 0.1, 0.1) * k; // inside-out shows red (B&W: dark)
        // fine iso-lines every 2 cm help read curvature
        float l = abs(fract(vW.y * 50.0) - 0.5);
        c *= 0.85 + 0.15 * smoothstep(0.0, 0.08, l);
        gl_FragColor = vec4(c, distance(vW, cameraPosition));
      }`,
  });
}
export function clay(THREE, meshes, tint = 1) {
  const mat = clayMaterial(THREE, tint);
  const saved = meshes.map((m) => [m, m.material]);
  for (const m of meshes) m.material = mat;
  return () => saved.forEach(([m, mm]) => (m.material = mm));
}
// clay shading that keeps a material's own vertex shader (skinned shoulders, breathing)
export function clayFrom(THREE, src, tint = 0.22) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    defines: { ...src.defines },
    uniforms: { ...src.uniforms, uTint: { value: tint } },
    vertexShader: src.vertexShader,
    fragmentShader: `
      uniform float uTint; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 N = normalize(vN);
        if (!gl_FrontFacing) N = -N;
        float k = 0.18 + 0.62 * max(dot(N, normalize(vec3(0.4, 0.8, 0.45))), 0.0) + 0.2 * max(dot(N, normalize(vec3(-0.6, 0.2, -0.7))), 0.0);
        vec3 c = vec3(k) * uTint;
        if (!gl_FrontFacing) c *= 0.3;
        float l = abs(fract(vW.y * 50.0) - 0.5);
        c *= 0.85 + 0.15 * smoothstep(0.0, 0.08, l);
        gl_FragColor = vec4(c, distance(vW, cameraPosition));
      }`,
  });
}
