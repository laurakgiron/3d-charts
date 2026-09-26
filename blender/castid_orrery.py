# Castid 3D — build a chart window in Blender from an exported scene JSON.
#
# In the web app, open a chart window and press EXPORT · SCENE JSON. Then in
# Blender (3.x / 4.x):
#   Scripting tab → Open this file → set JSON_PATH below (or pass it after
#   "--" on the command line) → Run Script.
#   blender --python castid_orrery.py -- /path/to/Hypatia.castid3d.json
#
# Geometry matches the web scene: the ecliptic is the XY plane (Blender is
# z-up, so the ecliptic pole is +Z), 0° Aries is +X, longitudes run
# counter-clockwise seen from above. Zodiac rim at radius 10, one storey per
# stacked ring, 2.2 units apart. Planets sit on Chaldean shells at their true
# geocentric longitude and latitude. The horizon and meridian are great
# circles of the sphere through the observer.

import json, math, sys
import bpy
from mathutils import Vector

JSON_PATH = ""  # e.g. "/Users/laura/Downloads/Hypatia_Natal.castid3d.json"

R_OUT, R_IN, R_HUB, STOREY = 10.0, 8.7, 1.1, 2.2
BODY_R = {"sun": 0.3, "moon": 0.22, "jupiter": 0.26, "saturn": 0.25, "uranus": 0.2, "neptune": 0.2}
INK, PLASTER, GOLD = "#0755BB", "#EDEAE4", "#B8922E"
ASPECT_COLORS = {"conjunction": "#6B6E73", "sextile": "#2E6B5E", "square": "#C0392B", "trine": "#0755BB", "opposition": "#8A2B20"}


def hex_rgba(h, a=1.0):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    # sRGB → linear for the Principled BSDF
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), a)


_mats = {}
def material(color, emit=0.0, alpha=1.0, metallic=0.1, rough=0.55):
    key = (color, emit, alpha, metallic, rough)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(f"castid_{color}_{emit}_{alpha}")
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    rgba = hex_rgba(color, alpha)
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = alpha
    if emit:
        bsdf.inputs["Emission Color" if "Emission Color" in bsdf.inputs else "Emission"].default_value = rgba
        bsdf.inputs["Emission Strength"].default_value = emit
    if alpha < 1:
        m.blend_method = "BLEND"
    _mats[key] = m
    return m


def lonlat(lon, lat=0.0, r=1.0):
    l, b = math.radians(lon), math.radians(lat)
    return Vector((r * math.cos(b) * math.cos(l), r * math.cos(b) * math.sin(l), r * math.sin(b)))


def link(obj, coll):
    coll.objects.link(obj)
    return obj


def polyline(name, points, coll, color=INK, bevel=0.012, closed=False, alpha=1.0):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = bevel
    cu.bevel_resolution = 2
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for p, v in zip(sp.points, points):
        p.co = (v.x, v.y, v.z, 1.0)
    sp.use_cyclic_u = closed
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(material(color, alpha=alpha))
    return link(ob, coll)


def circle_flat(name, r, z, coll, color=INK, bevel=0.012, n=180, alpha=1.0):
    pts = [Vector((r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z)) for i in range(n)]
    return polyline(name, pts, coll, color, bevel, True, alpha)


def great_circle(pole, r, n=180, start=None):
    p = Vector(pole).normalized()
    a = Vector(start) if start else (Vector((0, 0, 1)) if abs(p.z) < 0.9 else Vector((1, 0, 0)))
    a = p.cross(a).cross(p).normalized()
    b = p.cross(a)
    return [(a * math.cos(t) + b * math.sin(t)) * r for t in (2 * math.pi * i / n for i in range(n))]


def sphere(name, pos, r, coll, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=32, ring_count=16, location=pos)
    ob = bpy.context.active_object
    ob.name = name
    bpy.ops.object.shade_smooth()
    ob.data.materials.append(mat)
    for c in ob.users_collection:
        c.objects.unlink(ob)
    return link(ob, coll)


def label(name, text, pos, coll, size=0.6, color=INK):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = text
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = 0.01
    ob = bpy.data.objects.new(name, cu)
    ob.location = pos
    ob.data.materials.append(material(color))
    return link(ob, coll)


def rod(name, a, b, radius, coll, color, alpha=1.0):
    return polyline(name, [Vector(a), Vector(b)], coll, color, radius, False, alpha)


def build(data):
    root = bpy.data.collections.new(f"CASTID · {data.get('title', 'chart')}")
    bpy.context.scene.collection.children.link(root)
    rings = data["rings"]
    base = rings[0]

    # zodiac band
    band = bpy.data.collections.new("zodiac"); root.children.link(band)
    circle_flat("rim", R_OUT, 0, band)
    circle_flat("rim.inner", R_IN, 0, band)
    circle_flat("hub", R_HUB, 0, band, bevel=0.008)
    for s in range(12):
        polyline(f"sign.{s}", [lonlat(s * 30, 0, R_IN), lonlat(s * 30, 0, R_OUT)], band)
    for d in range(0, 360, 10):
        polyline(f"tick.{d}", [lonlat(d, 0, R_IN), lonlat(d, 0, R_IN - 0.3)], band, bevel=0.006)

    # houses & angles
    if base.get("cusps"):
        hc = bpy.data.collections.new("houses"); root.children.link(hc)
        for i, c in enumerate(base["cusps"]):
            polyline(f"cusp.{i + 1}", [lonlat(c, 0, R_HUB), lonlat(c, 0, R_IN)], hc, bevel=0.03 if i % 3 == 0 else 0.008)
    fr = data.get("frame")
    if fr:
        sky = bpy.data.collections.new("sky"); root.children.link(sky)
        asc_v, mc_v = lonlat(fr["asc"]), lonlat(fr["mc"])
        polyline("horizon", great_circle(fr["zenith"], R_OUT, start=asc_v), sky, bevel=0.018, closed=True)
        polyline("meridian", great_circle(fr["east"], R_OUT, start=mc_v), sky, bevel=0.012, closed=True)
        polyline("equator", great_circle(fr["pole"], R_OUT), sky, bevel=0.006, closed=True, alpha=0.6)
        rod("axis.asc", -asc_v * R_OUT, asc_v * R_OUT, 0.045, sky, INK)
        rod("axis.mc", -mc_v * R_OUT, mc_v * R_OUT, 0.03, sky, INK)
        for t, v in (("AC", asc_v), ("DC", -asc_v), ("MC", mc_v), ("IC", -mc_v)):
            label(f"angle.{t}", t, v * (R_OUT + 0.9), sky)
        # horizon disc
        bpy.ops.mesh.primitive_circle_add(radius=R_OUT, vertices=96, fill_type="NGON", location=(0, 0, 0))
        disc = bpy.context.active_object; disc.name = "horizon.disc"
        disc.rotation_mode = "QUATERNION"
        disc.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(fr["zenith"]).normalized())
        disc.data.materials.append(material(PLASTER, alpha=0.25))
        for c in disc.users_collection: c.objects.unlink(disc)
        sky.objects.link(disc)
        sphere("zenith", Vector(fr["zenith"]) * R_OUT, 0.1, sky, material(INK))

    # storeys
    for k, ring in enumerate(rings):
        col = bpy.data.collections.new(f"ring.{k}.{ring['name']}"); root.children.link(col)
        z = k * STOREY
        color = ring["color"]
        if k > 0:
            circle_flat(f"floor.{k}", R_IN, z, col, color, alpha=0.7)
            label(f"floor.{k}.name", ring["name"].upper(), Vector((0, -(R_IN + 1.0), z)), col, 0.5, color)
        shells = set()
        for p in ring["planets"]:
            if not p.get("shell"):
                continue
            if p["shell"] not in shells and p["key"] not in ("moon", "node", "snode"):
                shells.add(p["shell"])
                circle_flat(f"shell.{k}.{p['key']}", p["shell"], z, col, color, bevel=0.008, alpha=0.5)
            pos = Vector(p["xyz"]) + Vector((0, 0, z))
            if p["key"] in ("node", "snode"):
                label(f"{p['key']}.{k}", "☊" if p["key"] == "node" else "☋", pos, col, 0.45, color)
                continue
            mat = material(GOLD, emit=1.5) if p["key"] == "sun" else material(PLASTER, emit=0.1) if p["key"] == "moon" else material(color)
            sphere(f"{p['key']}.{k}", pos, BODY_R.get(p["key"], 0.17), col, mat)
            foot = lonlat(p["lon"], 0, p["shell"]) + Vector((0, 0, z))
            if abs(pos.z - z) > 0.02:
                polyline(f"{p['key']}.{k}.stem", [foot, pos], col, color, 0.006, alpha=0.6)
            label(f"{p['key']}.{k}.label", p["name"].upper(), pos + Vector((0, 0, BODY_R.get(p['key'], 0.17) + 0.35)), col, 0.28, color)
        # Moon's inclined orbit
        node = next((p for p in ring["planets"] if p["key"] == "node"), None)
        moon = next((p for p in ring["planets"] if p["key"] == "moon"), None)
        if node and moon:
            O, i = math.radians(node["lon"]), math.radians(5.145)
            n = Vector((math.cos(O), math.sin(O), 0))
            up = Vector((0, 0, 1))
            pole = up * math.cos(i) + n.cross(up) * math.sin(i) + n * n.dot(up) * (1 - math.cos(i))
            pts = [v + Vector((0, 0, z)) for v in great_circle(pole, moon["shell"], start=n)]
            polyline(f"moon.orbit.{k}", pts, col, color, 0.01, True, alpha=0.7)

    # aspects
    if data.get("aspects"):
        ac = bpy.data.collections.new("aspects"); root.children.link(ac)
        by = {(k, p["key"]): p for k, r in enumerate(rings) for p in r["planets"]}
        for j, a in enumerate(data["aspects"]):
            pa, pb = by.get((a["ringA"], a["a"])), by.get((a["ringB"], a["b"]))
            if not pa or not pb:
                continue
            A = Vector(pa["xyz"]) + Vector((0, 0, a["ringA"] * STOREY))
            B = Vector(pb["xyz"]) + Vector((0, 0, a["ringB"] * STOREY))
            rod(f"aspect.{j}.{a['type']}", A, B, max(0.012, 0.055 - a["orb"] * 0.005), ac, ASPECT_COLORS.get(a["type"], INK))

    # a camera and light, roughly the web's oblique view
    bpy.ops.object.light_add(type="SUN", location=(-14, -16, 22))
    bpy.context.active_object.data.energy = 3.0
    bpy.ops.object.camera_add(location=(0, -26, 19), rotation=(math.radians(54), 0, 0))
    bpy.context.scene.camera = bpy.context.active_object
    bpy.context.scene.world.use_nodes = True
    bg = bpy.context.scene.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = hex_rgba("#DCDCDC")
    print(f"Castid 3D: built {len(rings)} ring(s), {len(data.get('aspects', []))} aspect(s).")


def main():
    path = JSON_PATH
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--") + 1:]
        if args:
            path = args[0]
    if not path:
        raise SystemExit("Set JSON_PATH at the top of the script, or pass the file after '--'.")
    with open(path, encoding="utf-8") as f:
        build(json.load(f))


main()
