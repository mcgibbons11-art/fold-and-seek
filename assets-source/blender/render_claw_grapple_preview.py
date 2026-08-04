import bpy
import os
from mathutils import Vector

root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
output = os.path.join(root, "assets-source", "previews", "claw-grapple-deploy-frame18.png")
os.makedirs(os.path.dirname(output), exist_ok=True)

scene = bpy.context.scene
scene.frame_set(18)
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1100
scene.render.resolution_y = 700
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = output
scene.render.film_transparent = False
scene.world.color = (0.025, 0.032, 0.045)

camera = scene.camera
camera.location = (1.25, -1.25, 0.72)
target = Vector((0, 0.58, 0.04))
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.lens = 55

bpy.ops.render.render(write_still=True)
print(output)
