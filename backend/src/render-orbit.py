import bpy
import math
import os
import sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
model_path, frame_dir, ratio = args
dimensions = {'9:16': (540, 960), '1:1': (720, 720), '4:5': (648, 810), '16:9': (960, 540)}
width, height = dimensions[ratio]
os.makedirs(frame_dir, exist_ok=True)

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=model_path)
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not meshes:
    raise RuntimeError('A fotogrametria não produziu uma malha 3D renderizável.')

depsgraph = bpy.context.evaluated_depsgraph_get()
world_points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
minimum = Vector(tuple(min(point[i] for point in world_points) for i in range(3)))
maximum = Vector(tuple(max(point[i] for point in world_points) for i in range(3)))
center = (minimum + maximum) * 0.5
extent = max(maximum[i] - minimum[i] for i in range(3))
if extent <= 0:
    raise RuntimeError('O modelo 3D reconstruído está vazio.')

bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
product = bpy.context.object
product.name = 'Product'
product.location -= center
factor = 2.1 / extent
product.scale = (factor, factor, factor)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

pivot = bpy.data.objects.new('ProductOrbit', None)
bpy.context.collection.objects.link(pivot)
product.parent = pivot

bpy.ops.object.camera_add(location=(0, -7.0, 0.25))
camera = bpy.context.object
camera.name = 'ProductCamera'
camera.rotation_euler = (math.radians(88), 0, 0)
camera.data.lens = 48
scene = bpy.context.scene
scene.camera = camera

for location, energy, size in [((-3.5, -4.0, 4.5), 850, 4.0), ((3.0, -2.0, 1.0), 500, 3.0), ((0.0, 3.5, 3.0), 1100, 3.5)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    direction = Vector((0, 0, 0)) - light.location
    light.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 12
scene.cycles.use_denoising = True
scene.render.resolution_x = width
scene.render.resolution_y = height
scene.render.resolution_percentage = 100
scene.render.fps = 24
scene.frame_start = 1
scene.frame_end = 432
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = True
scene.render.filepath = os.path.join(frame_dir, 'orbit_')
scene.view_settings.view_transform = 'Standard'
scene.render.image_settings.color_depth = '8'
scene.render.use_file_extension = True
scene.render.threads_mode = 'FIXED'
scene.render.threads = 3

pivot.rotation_euler[2] = 0
pivot.keyframe_insert(data_path='rotation_euler', index=2, frame=1)
pivot.rotation_euler[2] = 2 * math.pi
pivot.keyframe_insert(data_path='rotation_euler', index=2, frame=432)
for curve in pivot.animation_data.action.fcurves:
    for key in curve.keyframe_points:
        key.interpolation = 'LINEAR'

bpy.ops.render.render(animation=True)
