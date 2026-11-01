# -*- coding: utf-8 -*-
# Exporta, desde ArcGIS Pro, las capas que necesita la revisión asistida para un trámite.
# Uso: ejecutar en la Python de ArcGIS Pro (Analysis > Tools > Python Window o como herramienta).
# Entrada: CBML del trámite y la GDB de edición temporal. Salida: un ZIP con shapefiles en EPSG 9377.
import arcpy, os, shutil, zipfile, sys

GDB = r"C:\SERAG2\SERAGtemp.gdb"          # ajustar a la GDB de edición del trámite
CAPAS = ["lote", "construccion", "uconstruccion_ladm"]   # predio y lote_detalle no se usan en la primera versión
CBML = sys.argv[1] if len(sys.argv) > 1 else "04080220024"
SALIDA = r"C:\QA_CATASTRAL\salida_" + CBML
EPSG = 9377

if os.path.exists(SALIDA):
    shutil.rmtree(SALIDA)
os.makedirs(SALIDA)

arcpy.env.workspace = GDB
arcpy.env.outputCoordinateSystem = arcpy.SpatialReference(EPSG)

for capa in CAPAS:
    if not arcpy.Exists(capa):
        arcpy.AddWarning("No existe la capa " + capa)
        continue
    lyr = "lyr_" + capa
    arcpy.MakeFeatureLayer_management(capa, lyr, "cbml = '%s'" % CBML)
    n = int(arcpy.GetCount_management(lyr)[0])
    arcpy.AddMessage("%s: %d registros" % (capa, n))
    if n:
        arcpy.conversion.FeatureClassToShapefile(lyr, SALIDA)
        arcpy.management.Delete(lyr)

zip_path = SALIDA + ".zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for f in os.listdir(SALIDA):
        if f.endswith((".shp", ".shx", ".dbf", ".prj", ".cpg")):
            z.write(os.path.join(SALIDA, f), f)
print("ZIP generado: " + zip_path)
