const meta = { name: 'Camping lantern' };

// Dimensions in metres; change together via these parameters.
const P = {
  baseR: 0.095, baseH: 0.035,
  glassR: 0.075, glassH: 0.2,
  postR: 0.006, postOffset: 0.083,
  capH: 0.05, capR: 0.105,
  handleR: 0.085, handleTube: 0.007,
};

function build() {
  const root = createRoot('CampingLantern');
  const metal = gameMaterial(0x2f3a33, { metalness: 0.6, roughness: 0.5 });
  const brass = gameMaterial(0xb08d57, { metalness: 0.7, roughness: 0.4 });
  const glass = glassMaterial(0xcfe8ff, { opacity: 0.35, roughness: 0.1 });
  const flameMat = gameMaterial(0xffb347, { emissive: 0xff9a1f, emissiveIntensity: 2 });

  const baseTop = P.baseH;
  const glassMid = baseTop + P.glassH / 2;
  const glassTop = baseTop + P.glassH;

  createPart('Base', cylinderGeo(P.baseR - 0.01, P.baseR, P.baseH, 32), metal,
    { position: [0, P.baseH / 2, 0], parent: root });
  createPart('FuelFont', cylinderGeo(0.045, 0.05, 0.03, 24), brass,
    { position: [0, baseTop + 0.015, 0], parent: root });
  createPart('Glass', cylinderGeo(P.glassR, P.glassR, P.glassH, 32), glass,
    { position: [0, glassMid, 0], parent: root });
  createPart('Flame', sphereGeo(0.028, 16, 12), flameMat,
    { position: [0, baseTop + 0.075, 0], scale: [1, 1.5, 1], parent: root });

  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    createPart(`Post_${i + 1}`, cylinderGeo(P.postR, P.postR, P.glassH + 0.01, 10), metal,
      { position: [Math.cos(a) * P.postOffset, glassMid, Math.sin(a) * P.postOffset], parent: root });
  }

  createPart('CapRing', cylinderGeo(P.glassR + 0.012, P.glassR + 0.012, 0.012, 32), brass,
    { position: [0, glassTop + 0.006, 0], parent: root });
  createPart('Cap', cylinderGeo(0.03, P.capR, P.capH, 32), metal,
    { position: [0, glassTop + 0.012 + P.capH / 2, 0], parent: root });
  createPart('CapKnob', sphereGeo(0.016, 12, 8), brass,
    { position: [0, glassTop + 0.012 + P.capH + 0.008, 0], parent: root });

  const handleY = glassTop + 0.012 + P.capH + P.handleR - 0.002; // ring rests on the cap
  createPart('Handle', torusGeo(P.handleR, P.handleTube, 10, 40), brass,
    { position: [0, handleY, 0], parent: root });

  return root;
}
