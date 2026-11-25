# Repackage classes to remove package-name overhead from the release DEX.
# This is an app-level optimization; keep rules from the Android manifest and
# bundled libraries continue to protect runtime entry points.
-repackageclasses
