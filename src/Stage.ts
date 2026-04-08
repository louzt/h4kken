// ============================================================
// H4KKEN - Stage (Arena, Lighting, Environment)
// Bright tournament arena with proper fighting-game aesthetics
// ============================================================

import * as THREE from 'three';

export class Stage {
  scene: THREE.Scene;
  objects: THREE.Object3D[];
  time: number;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.objects = [];
    this.time = 0;
    this.build();
  }

  build() {
    const arenaRadius = 14;
    const platformGeo = new THREE.CylinderGeometry(arenaRadius, arenaRadius + 0.3, 0.6, 32);
    const platformMat = new THREE.MeshStandardMaterial({
      color: 0xc8b89a,
      metalness: 0.15,
      roughness: 0.55,
    });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.y = -0.3;
    platform.receiveShadow = true;
    this.scene.add(platform);
    this.objects.push(platform);

    const fightAreaGeo = new THREE.CylinderGeometry(10, 10, 0.08, 32);
    const fightAreaMat = new THREE.MeshStandardMaterial({
      color: 0x8b7355,
      metalness: 0.3,
      roughness: 0.35,
    });
    const fightArea = new THREE.Mesh(fightAreaGeo, fightAreaMat);
    fightArea.position.y = 0.01;
    fightArea.receiveShadow = true;
    this.scene.add(fightArea);
    this.objects.push(fightArea);

    const centerGeo = new THREE.PlaneGeometry(0.06, 6);
    const centerMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.5,
    });
    const centerLine = new THREE.Mesh(centerGeo, centerMat);
    centerLine.rotation.x = -Math.PI / 2;
    centerLine.position.y = 0.06;
    this.scene.add(centerLine);

    const ringGeo = new THREE.TorusGeometry(10, 0.08, 6, 32);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      metalness: 0.8,
      roughness: 0.2,
      emissive: new THREE.Color(0xaa8800),
      emissiveIntensity: 0.3,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.06;
    this.scene.add(ring);
    this.objects.push(ring);

    const outerRingGeo = new THREE.TorusGeometry(arenaRadius, 0.12, 6, 32);
    const outerRingMat = new THREE.MeshStandardMaterial({
      color: 0x997744,
      metalness: 0.5,
      roughness: 0.4,
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRing.rotation.x = Math.PI / 2;
    outerRing.position.y = 0.02;
    this.scene.add(outerRing);
    this.objects.push(outerRing);

    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x6b8f5e });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.6;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const pillarAngles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
    const pillarDist = arenaRadius + 1.5;

    pillarAngles.forEach((angle, i) => {
      const px = Math.cos(angle) * pillarDist;
      const pz = Math.sin(angle) * pillarDist;

      const baseGeo = new THREE.CylinderGeometry(0.45, 0.55, 0.8, 6);
      const baseMat = new THREE.MeshLambertMaterial({ color: 0x887766 });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.set(px, 0.1, pz);
      this.scene.add(base);

      const colGeo = new THREE.CylinderGeometry(0.3, 0.35, 5, 6);
      const colMat = new THREE.MeshLambertMaterial({ color: 0x998877 });
      const col = new THREE.Mesh(colGeo, colMat);
      col.position.set(px, 3, pz);
      this.scene.add(col);

      const capGeo = new THREE.CylinderGeometry(0.5, 0.35, 0.4, 6);
      const capMat = new THREE.MeshLambertMaterial({ color: 0xaa9977 });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(px, 5.7, pz);
      this.scene.add(cap);

      const flame = new THREE.PointLight(i % 2 === 0 ? 0xff6622 : 0xff8844, 1.2, 18, 1.5);
      flame.position.set(px, 6.3, pz);
      flame.castShadow = false;
      this.scene.add(flame);
      this.objects.push(flame);
    });

    this.createBackdrop();
    this.setupLighting();

    const skyGeo = new THREE.SphereGeometry(90, 16, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x3388cc) },
        horizColor: { value: new THREE.Color(0x99ccee) },
        bottomColor: { value: new THREE.Color(0x88aa77) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          vec3 color;
          if (h > 0.0) {
            color = mix(horizColor, topColor, pow(h, 0.5));
          } else {
            color = mix(horizColor, bottomColor, pow(-h, 0.4));
          }
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(sky);

    this.scene.fog = new THREE.Fog(0x99ccee, 40, 90);
  }

  setupLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x88bbff, 0x445522, 0.7);
    hemi.position.set(0, 20, 0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff5e0, 1.6);
    sun.position.set(8, 18, 10);
    sun.castShadow = true;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 50;
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    sun.shadow.bias = -0.001;
    this.scene.add(sun);
  }

  createBackdrop() {
    const mountainDefs = [
      { x: -45, z: -55, h: 22, r: 14, c: 0x667766 },
      { x: -25, z: -60, h: 30, r: 18, c: 0x5a6b5a },
      { x: 5, z: -65, h: 35, r: 20, c: 0x556655 },
      { x: 30, z: -58, h: 25, r: 15, c: 0x607060 },
      { x: 50, z: -55, h: 20, r: 12, c: 0x6b7b6b },
      { x: -55, z: -50, h: 18, r: 11, c: 0x708070 },
      { x: 55, z: -60, h: 24, r: 16, c: 0x5e6e5e },
    ];

    mountainDefs.forEach((m) => {
      const geo = new THREE.ConeGeometry(m.r, m.h, 5);
      const mat = new THREE.MeshLambertMaterial({ color: m.c, flatShading: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(m.x, m.h / 2 - 2, m.z);
      mesh.rotation.y = Math.random() * Math.PI;
      this.scene.add(mesh);
    });

    mountainDefs
      .filter((m) => m.h > 25)
      .forEach((m) => {
        const capGeo = new THREE.ConeGeometry(m.r * 0.35, m.h * 0.2, 5);
        const capMat = new THREE.MeshLambertMaterial({ color: 0xdde8dd, flatShading: true });
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.set(m.x, m.h - 2, m.z);
        cap.rotation.y = Math.random() * Math.PI;
        this.scene.add(cap);
      });

    const treeCount = 14;
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x664422 });
    const leafMats = [
      new THREE.MeshLambertMaterial({ color: 0x2e6b1e, flatShading: true }),
      new THREE.MeshLambertMaterial({ color: 0x388526, flatShading: true }),
      new THREE.MeshLambertMaterial({ color: 0x429f2e, flatShading: true }),
    ];

    for (let i = 0; i < treeCount; i++) {
      const angle = (i / treeCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const dist = 20 + Math.random() * 12;
      const tx = Math.cos(angle) * dist;
      const tz = Math.sin(angle) * dist;
      const s = 0.7 + Math.random() * 0.8;

      const trunkGeo = new THREE.CylinderGeometry(0.15 * s, 0.25 * s, 3 * s, 5);
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(tx, 1.5 * s - 0.6, tz);
      this.scene.add(trunk);

      for (let j = 0; j < 3; j++) {
        const r = (2.2 - j * 0.5) * s;
        const h = (2.0 - j * 0.3) * s;
        const y = (2.5 + j * 1.4) * s - 0.6;
        const leafGeo = new THREE.ConeGeometry(r, h, 5);
        const leaf = new THREE.Mesh(leafGeo, leafMats[j]);
        leaf.position.set(tx, y, tz);
        leaf.rotation.y = Math.random() * Math.PI;
        this.scene.add(leaf);
      }
    }
  }

  update(deltaTime: number) {
    this.time += deltaTime;

    for (const obj of this.objects) {
      if ((obj as THREE.PointLight).isPointLight) {
        const light = obj as THREE.PointLight;
        light.intensity =
          1.0 +
          Math.sin(this.time * 6 + obj.position.x) * 0.3 +
          Math.sin(this.time * 9.7 + obj.position.z) * 0.15;
      }
    }
  }
}
