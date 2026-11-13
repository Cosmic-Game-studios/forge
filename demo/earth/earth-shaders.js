// GLSL für Erde, Wolken und Atmosphäre. Alle Vektoren liegen im Weltraum (world space).

const SHARED = /* glsl */`
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vPosition;

  const vec3 SUN_COLOR = vec3(1.0, 0.96, 0.9) * 2.1;
  const vec3 ATMOSPHERE_COLOR = vec3(0.3, 0.6, 1.0);
  const vec3 TWILIGHT_COLOR = vec3(1.0, 0.45, 0.2);

  // 1 genau an der Tag-Nacht-Grenze, 0 abseits davon.
  float twilightBand(float sunDot) {
    return smoothstep(-0.25, 0.0, sunDot) * (1.0 - smoothstep(0.0, 0.4, sunDot));
  }
`;

export const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vUv = uv;
    vNormal = mat3(modelMatrix) * normal;
    // Auf einer Kugel zeigt die Tangente (Richtung wachsender u-Koordinate) nach Osten.
    vTangent = mat3(modelMatrix) * vec3(normal.z, 0.0, -normal.x);
    vPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const EARTH_FRAGMENT_SHADER = /* glsl */`
  ${SHARED}
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D normalMap;
  uniform sampler2D specularMap;
  uniform sampler2D cloudMap;
  // Verschiebung der Wolkentextur gegenüber der Erde in u-Einheiten.
  uniform float cloudShift;

  const float NIGHT_LIGHTS_STRENGTH = 3.0;

  void main() {
    vec3 surfaceNormal = normalize(vNormal);
    // Der kleine Versatz verhindert eine Nulllänge an den Polen.
    vec3 tangent = normalize(vTangent + vec3(1e-5, 0.0, 0.0));
    vec3 bitangent = cross(surfaceNormal, tangent);
    vec3 detail = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
    detail.xy *= vec2(0.8, -0.8);
    // Die Textur enthält fast waagrechte Normalen; ohne Untergrenze werden steile Hänge
    // auch bei hohem Sonnenstand zu schwarzen Blöcken.
    detail.z = max(detail.z, 0.6);
    vec3 normal = normalize(tangent * detail.x + bitangent * detail.y + surfaceNormal * detail.z);

    vec3 viewDirection = normalize(cameraPosition - vPosition);
    float sunDot = dot(surfaceNormal, sunDirection);
    float day = smoothstep(-0.1, 0.2, sunDot);
    float twilight = twilightBand(sunDot);

    vec4 cloudSample = texture2D(cloudMap, vUv - vec2(cloudShift, 0.0));
    float cloud = cloudSample.r * cloudSample.a;
    vec3 sunLight = SUN_COLOR * mix(vec3(1.0), TWILIGHT_COLOR, twilight)
      * smoothstep(-0.02, 0.06, sunDot) * (1.0 - 0.55 * cloud);

    vec3 albedo = texture2D(dayMap, vUv).rgb;
    float ocean = texture2D(specularMap, vUv).r;
    vec3 color = albedo * sunLight * max(dot(normal, sunDirection), 0.0);

    vec3 halfVector = normalize(sunDirection + viewDirection);
    float glint = pow(max(dot(surfaceNormal, halfVector), 0.0), 220.0);
    color += sunLight * glint * ocean * 1.5;

    color += albedo * 0.012;
    color += texture2D(nightMap, vUv).rgb * NIGHT_LIGHTS_STRENGTH * (1.0 - day) * (1.0 - 0.7 * cloud);

    float fresnel = pow(1.0 - max(dot(viewDirection, surfaceNormal), 0.0), 3.0);
    vec3 haze = mix(ATMOSPHERE_COLOR, TWILIGHT_COLOR, twilight * 0.6);
    color += haze * fresnel * smoothstep(-0.2, 0.5, sunDot);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const CLOUD_FRAGMENT_SHADER = /* glsl */`
  ${SHARED}
  uniform sampler2D cloudMap;

  void main() {
    float sunDot = dot(normalize(vNormal), sunDirection);
    float lit = smoothstep(-0.1, 0.5, sunDot);
    vec4 cloudSample = texture2D(cloudMap, vUv);
    vec3 color = SUN_COLOR * mix(vec3(1.0), TWILIGHT_COLOR, twilightBand(sunDot)) * lit * 0.8;
    // Nachts unsichtbar: das Abdunkeln der Stadtlichter übernimmt der Erd-Shader.
    gl_FragColor = vec4(color, cloudSample.r * cloudSample.a * lit);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Für die Innenseite (BackSide) einer etwas größeren Hülle, additiv gemischt.
export const ATMOSPHERE_FRAGMENT_SHADER = /* glsl */`
  ${SHARED}

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDirection = normalize(cameraPosition - vPosition);
    // 0 am Außenrand der Hülle, wächst zum Erdrand hin.
    float depth = -dot(normal, viewDirection);
    float glow = pow(smoothstep(0.0, 0.55, depth), 3.0);
    float sunDot = dot(normal, sunDirection);
    vec3 color = mix(TWILIGHT_COLOR * 0.6, ATMOSPHERE_COLOR, smoothstep(-0.2, 0.25, sunDot));
    gl_FragColor = vec4(color * glow * smoothstep(-0.35, 0.4, sunDot) * 1.2, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
