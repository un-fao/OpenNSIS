"""Build-time patch for pyCSW 3.0.0-beta1 (see sis-metadata/Dockerfile).

Upstream bug: record2json() MUTATES the SQLAlchemy record object while
serialising the licence —

    record.otherconstraints = [record.otherconstraints]

— so the first serialisation by a worker turns the cached attribute from a
string into a list, and every later serialisation by that same worker fails
the isinstance(str) guard and silently drops properties.license. Symptom:
single-item responses right after a restart carry the licence, paged list
responses (what harvesters use) lose it per worker over time.

This rewrites the block to be read-only. Drop the patch once a fixed pyCSW
release is pinned.
"""
PATH = "/home/pycsw/pycsw/pycsw/ogc/api/records.py"

OLD = """    if record.otherconstraints:
        if isinstance(record.otherconstraints, str) and record.otherconstraints not in [None, 'None']:
            record.otherconstraints = [record.otherconstraints]
            record_dict['properties']['license'] = ", ".join(record.otherconstraints)
"""

NEW = """    if record.otherconstraints:
        oc = record.otherconstraints
        if isinstance(oc, str) and oc not in [None, 'None']:
            oc = [oc]
        if isinstance(oc, list) and oc:
            record_dict['properties']['license'] = ", ".join(str(x) for x in oc)
"""

src = open(PATH).read()
assert src.count(OLD) == 1, "pyCSW source changed — review patch_license.py"
open(PATH, "w").write(src.replace(OLD, NEW))
print("pycsw record2json licence block patched (read-only serialisation)")
