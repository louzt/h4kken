"""
Export a Quaternius UAL .blend pack as an animation-only GLB (rig + actions,
no mesh).

Args via env vars:
  UAL_BLEND   absolute path to UAL*.blend
  UAL_OUT     absolute path to write the GLB output

No Blender addons needed.

Run headlessly:
  UAL_BLEND=~/UAL1.blend UAL_OUT=public/assets/models/ual1_anims.glb \
    blender -b -P export_ual_anims.py
"""
import bpy
import os
import sys


UAL_BLEND = os.environ.get('UAL_BLEND')
UAL_OUT = os.environ.get('UAL_OUT')


def main():
    if not UAL_BLEND or not UAL_OUT:
        print('ERROR: set UAL_BLEND and UAL_OUT env vars')
        sys.exit(1)

    bpy.ops.wm.open_mainfile(filepath=UAL_BLEND)

    # Drop any meshes / empties — we only want the rig + actions.
    for o in list(bpy.data.objects):
        if o.type == 'MESH' or o.type == 'EMPTY':
            bpy.data.objects.remove(o, do_unlink=True)

    arm = None
    for o in bpy.data.objects:
        if o.type == 'ARMATURE':
            arm = o
            break
    if arm is None:
        print(f"ERROR: no armature in {UAL_BLEND}")
        sys.exit(1)

    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm

    print(f"exporting {len(bpy.data.actions)} actions via {arm.name} → {UAL_OUT}")

    os.makedirs(os.path.dirname(UAL_OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=UAL_OUT,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_nla_strips=False,
        export_apply=False,
        export_yup=True,
        export_skins=True,
        export_morph=False,
        export_materials='NONE',
    )
    print(f"  wrote {os.path.getsize(UAL_OUT):,} bytes")


main()
