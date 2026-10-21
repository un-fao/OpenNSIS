# Pinned upstream image (same digest the compose file used before this
# Dockerfile existed) plus one build-time patch — see patch_license.py for
# the upstream record2json mutation bug that loses properties.license from
# OGC API Records list responses. Re-pin and drop the patch once a fixed
# pyCSW release exists.
FROM geopython/pycsw:3.0.0-beta1@sha256:e17ecf1fe5271ed2671ca27a49561d07b597927889f55242dfb65c24003f7bca

USER root
COPY patch_license.py /tmp/patch_license.py
RUN python3 /tmp/patch_license.py && rm /tmp/patch_license.py
USER pycsw
