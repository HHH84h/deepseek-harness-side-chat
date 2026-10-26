#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
exec /bin/bash tools/launcher.sh doctor "$@"
