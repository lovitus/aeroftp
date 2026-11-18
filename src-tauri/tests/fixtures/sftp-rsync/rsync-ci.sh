#!/bin/bash
# Keep server stderr observable even when the native SSH client stalls.
exec /usr/bin/rsync.real "$@" 2> >(tee -a /tmp/rsync-server.stderr >&2)
