"""
Export a Mixamo-rigged humanoid FBX as GLB with its skeleton rest baked to
the T-pose from its mixamo.com action. The resulting GLB is paired with
animation packs at build time in Babylon (see build-character.ts).

Args via env vars:
  MESH_FBX   absolute path to the input Mixamo FBX (T-pose action)
  MESH_OUT   absolute path to write the GLB output

No Blender addons needed — only stock bpy.ops.

Run headlessly:
  MESH_FBX=~/tmp/Character.fbx MESH_OUT=public/assets/models/mesh.glb \
    blender -b -P export_mesh.py
"""
import bpy
import os
import sys


MESH_FBX = os.environ.get('MESH_FBX')
MESH_OUT = os.environ.get('MESH_OUT')


def main():
    if not MESH_FBX or not MESH_OUT:
        print('ERROR: set MESH_FBX and MESH_OUT env vars')
        sys.exit(1)

    bpy.ops.wm.read_homefile(use_empty=True)

    # FBX importer needs an active object for context.
    bpy.ops.mesh.primitive_cube_add()
    bpy.ops.import_scene.fbx(filepath=MESH_FBX)

    cube = bpy.data.objects.get('Cube')
    if cube:
        bpy.data.objects.remove(cube, do_unlink=True)
    for o in list(bpy.data.objects):
        if o.name == 'world' or o.type == 'EMPTY':
            bpy.data.objects.remove(o, do_unlink=True)

    mesh = None
    rig = None
    for o in bpy.data.objects:
        if o.type == 'MESH':
            mesh = o
        elif o.type == 'ARMATURE':
            rig = o

    if not mesh or not rig:
        print('ERROR: FBX missing mesh or armature')
        sys.exit(1)

    print(f"mesh: {mesh.name}, armature: {rig.name}")

    # Mixamo ships with A-pose rest + a mixamo.com T-pose action at frame 1.
    # Bake the T-pose into BOTH the mesh verts AND the skeleton's rest pose so
    # the retargeter's math aligns source-rest with target-rest.
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh

    # Bake T-pose deformation into mesh verts.
    for m in list(mesh.modifiers):
        if m.type == 'ARMATURE':
            bpy.ops.object.modifier_apply(modifier=m.name)

    if mesh.parent:
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Bake the T-pose into the skeleton as its rest orientation.
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    if rig.animation_data:
        rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.rotation_euler = (0, 0, 0)
        pb.scale = (1, 1, 1)

    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Re-parent mesh to armature so the export writes skin bindings.
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_NAME')

    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)

    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig

    os.makedirs(os.path.dirname(MESH_OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=MESH_OUT,
        export_format='GLB',
        use_selection=True,
        export_animations=False,
        export_apply=False,
        export_yup=True,
        export_skins=True,
        export_morph=False,
        export_materials='EXPORT',
    )
    print(f"wrote {MESH_OUT} ({os.path.getsize(MESH_OUT):,} bytes)")


main()
