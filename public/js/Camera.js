// ============================================================
// H4KKEN - Fighting Game Camera
// ============================================================

import * as THREE from 'three';

export class FightCamera {
  constructor(camera) {
    this.camera = camera;
    this.targetPosition = new THREE.Vector3(0, 3, 10);
    this.targetLookAt = new THREE.Vector3(0, 1.2, 0);
    this.currentLookAt = new THREE.Vector3(0, 1.2, 0);
    this.smoothSpeed = 0.06;
    this.minDistance = 5;
    this.maxDistance = 11;
    this.heightOffset = 2.5;
    this.lookAtHeightOffset = 1.2;
    this.shakeIntensity = 0;
    this.shakeDuration = 0;
    this.shakeTimer = 0;
    // Camera orbit angle (radians) — smoothly tracks fight axis
    this.orbitAngle = Math.PI / 2; // start looking from +Z side
    
    // Initialize camera
    this.camera.position.copy(this.targetPosition);
    this.camera.lookAt(this.targetLookAt);
  }

  update(fighter1Pos, fighter2Pos, deltaTime, localPlayerIndex = 0) {
    // Calculate midpoint between fighters
    const midX = (fighter1Pos.x + fighter2Pos.x) / 2;
    const midY = Math.max((fighter1Pos.y + fighter2Pos.y) / 2, 0);
    const midZ = (fighter1Pos.z + fighter2Pos.z) / 2;

    // Fight axis: direction from local player to opponent
    // This ensures the local player is always on the LEFT side of the screen.
    const localPos = localPlayerIndex === 0 ? fighter1Pos : fighter2Pos;
    const remotePos = localPlayerIndex === 0 ? fighter2Pos : fighter1Pos;
    const dx = remotePos.x - localPos.x;
    const dz = remotePos.z - localPos.z;
    const fighterDist = Math.sqrt(dx * dx + dz * dz);

    // Camera orbit angle = perpendicular to fight axis
    // Fight axis angle = atan2(dz, dx), camera views from 90° offset
    if (fighterDist > 0.1) {
      const fightAngle = Math.atan2(dz, dx);
      let targetOrbit = fightAngle + Math.PI / 2;

      // Smooth shortest-arc interpolation for orbit angle
      let angleDiff = targetOrbit - this.orbitAngle;
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
      this.orbitAngle += angleDiff * 0.06;
    }

    // Dynamic zoom based on fighter distance
    const zoomFactor = THREE.MathUtils.clamp(fighterDist / 8, 0, 1);
    const depth = THREE.MathUtils.lerp(this.minDistance, this.maxDistance, zoomFactor);
    const height = this.heightOffset + zoomFactor * 1.5;

    // Camera position: orbit around midpoint, perpendicular to fight axis
    this.targetPosition.set(
      midX + Math.cos(this.orbitAngle) * depth,
      midY + height,
      midZ + Math.sin(this.orbitAngle) * depth
    );

    this.targetLookAt.set(
      midX,
      midY + this.lookAtHeightOffset,
      midZ
    );

    // Smooth interpolation
    this.camera.position.lerp(this.targetPosition, this.smoothSpeed);
    this.currentLookAt.lerp(this.targetLookAt, this.smoothSpeed);

    // Camera shake
    if (this.shakeTimer > 0) {
      this.shakeTimer -= deltaTime;
      const shakePower = this.shakeIntensity * (this.shakeTimer / this.shakeDuration);
      this.camera.position.x += (Math.random() - 0.5) * shakePower;
      this.camera.position.y += (Math.random() - 0.5) * shakePower * 0.5;
    }

    this.camera.lookAt(this.currentLookAt);
  }

  shake(intensity, duration) {
    this.shakeIntensity = intensity;
    this.shakeDuration = duration;
    this.shakeTimer = duration;
  }

  // Zoom in for dramatic moments (round end, KO)
  setDramaticAngle(focusPos) {
    const cosA = Math.cos(this.orbitAngle);
    const sinA = Math.sin(this.orbitAngle);
    this.targetPosition.set(
      focusPos.x + cosA * 4,
      focusPos.y + 2,
      focusPos.z + sinA * 4
    );
    this.targetLookAt.set(
      focusPos.x,
      focusPos.y + 1.2,
      focusPos.z
    );
    this.smoothSpeed = 0.03;
  }

  reset() {
    this.smoothSpeed = 0.06;
  }
}
