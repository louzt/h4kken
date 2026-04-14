// ============================================================
// H4KKEN - Effects Manager
// Manages the spark/particle pool for hit and block effects.
// Fully standalone — no dependency on Game or Fighter.
// ============================================================

import {
  Color3,
  type Mesh,
  MeshBuilder,
  type Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

export class EffectsManager {
  readonly hitParticles: Mesh[] = [];
  private _sparkPool: Mesh[] = [];
  private readonly _sparkGeo: Mesh;
  private readonly _hitMat0: StandardMaterial;
  private readonly _hitMat1: StandardMaterial;
  private readonly _blockMat: StandardMaterial;

  constructor(scene: Scene) {
    const sparkTemplate = MeshBuilder.CreateSphere(
      'sparkTemplate',
      { diameter: 0.06, segments: 2 },
      scene,
    );
    sparkTemplate.setEnabled(false);
    this._sparkGeo = sparkTemplate;

    this._hitMat0 = new StandardMaterial('hitMat0', scene);
    this._hitMat0.diffuseColor = new Color3(1, 0.4, 0);
    this._hitMat0.emissiveColor = new Color3(1, 0.4, 0);
    this._hitMat0.alpha = 1;

    this._hitMat1 = new StandardMaterial('hitMat1', scene);
    this._hitMat1.diffuseColor = new Color3(1, 0.8, 0);
    this._hitMat1.emissiveColor = new Color3(1, 0.8, 0);
    this._hitMat1.alpha = 1;

    this._blockMat = new StandardMaterial('blockMat', scene);
    this._blockMat.diffuseColor = new Color3(0.267, 0.533, 1);
    this._blockMat.emissiveColor = new Color3(0.267, 0.533, 1);
    this._blockMat.alpha = 1;

    // Pre-warm the spark pool — avoids mesh allocation stutter during the
    // first few hits of a match. 24 covers two simultaneous hit sparkbursts
    // (8 sparks each) + one block spark (4). Meshes are created once and
    // recycled for the entire match duration.
    for (let i = 0; i < 24; i++) {
      const spark = this._sparkGeo.clone(`spark_pool_${i}`);
      spark.setEnabled(false);
      this._sparkPool.push(spark);
    }
  }

  private _getPooledSpark(mat: StandardMaterial): Mesh {
    const pooled = this._sparkPool.pop();
    if (pooled !== undefined) {
      pooled.material = mat;
      pooled.setEnabled(true);
      return pooled;
    }
    const spark = this._sparkGeo.clone('spark');
    spark.material = mat;
    spark.setEnabled(true);
    return spark;
  }

  spawnHitSpark(position: Vector3, attackerFacingAngle: number): void {
    const cosA = Math.cos(attackerFacingAngle);
    const sinA = Math.sin(attackerFacingAngle);
    const count = 8;
    for (let i = 0; i < count; i++) {
      const mat = (i & 1) === 0 ? this._hitMat0 : this._hitMat1;
      const spark = this._getPooledSpark(mat);
      spark.position.set(
        position.x + cosA * 0.5,
        position.y + 1.2 + (Math.random() - 0.5) * 0.5,
        position.z + sinA * 0.5 + (Math.random() - 0.5) * 0.3,
      );
      spark.scaling.setAll(1);
      spark.metadata = {
        velocity: new Vector3(
          (Math.random() - 0.3) * 0.15 * cosA,
          Math.random() * 0.12,
          (Math.random() - 0.3) * 0.15 * sinA,
        ),
        life: 1.0,
        decay: 0.04 + Math.random() * 0.03,
        mat,
      };
      this.hitParticles.push(spark);
    }
  }

  spawnBlockSpark(position: Vector3): void {
    const count = 4;
    for (let i = 0; i < count; i++) {
      const spark = this._getPooledSpark(this._blockMat);
      spark.position.set(
        position.x,
        position.y + 1.2 + (Math.random() - 0.5) * 0.3,
        position.z + (Math.random() - 0.5) * 0.2,
      );
      spark.scaling.setAll(0.7);
      spark.metadata = {
        velocity: new Vector3(
          (Math.random() - 0.5) * 0.1,
          Math.random() * 0.08,
          (Math.random() - 0.5) * 0.08,
        ),
        life: 1.0,
        decay: 0.06,
        mat: this._blockMat,
      };
      this.hitParticles.push(spark);
    }
  }

  update(): void {
    for (let i = this.hitParticles.length - 1; i >= 0; i--) {
      const p = this.hitParticles[i];
      if (!p) continue;
      const d = p.metadata as {
        velocity: Vector3;
        life: number;
        decay: number;
        mat: StandardMaterial;
      };
      d.life -= d.decay;
      d.velocity.y -= 0.005;
      p.position.addInPlace(d.velocity);
      d.mat.alpha = d.life;
      p.scaling.setAll(d.life);

      if (d.life <= 0) {
        p.setEnabled(false);
        this._sparkPool.push(p);
        this.hitParticles.splice(i, 1);
      }
    }
  }
}
