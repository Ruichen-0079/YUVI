#!/usr/bin/env bash
# CI-only provisioner for the same PG16 + pgvector distribution contract as Linux packaging.
set -euo pipefail
: "${YUVI_LINUX_POSTGRES_HOME:?Set an isolated distribution destination}"
# PostgreSQL's build appends /postgresql to share/lib unless the prefix already
# contains postgres/pgsql. Match the project's existing flat distribution layout.
case "$YUVI_LINUX_POSTGRES_HOME" in
  *postgres*|*pgsql*) ;;
  *) printf '%s\n' 'Distribution prefix must contain postgres or pgsql.' >&2; exit 1 ;;
esac
task_build_dir=$(mktemp -d)
trap 'rm -rf "$task_build_dir"' EXIT
curl -fsSL https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2 -o "$task_build_dir/postgres.tar.bz2"
curl -fsSL https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.8.6 -o "$task_build_dir/vector.tar.gz"
printf '%s  %s\n' c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed "$task_build_dir/postgres.tar.bz2" | sha256sum -c -
printf '%s  %s\n' 10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f "$task_build_dir/vector.tar.gz" | sha256sum -c -
tar -xf "$task_build_dir/postgres.tar.bz2" -C "$task_build_dir"
tar -xf "$task_build_dir/vector.tar.gz" -C "$task_build_dir"
cd "$task_build_dir/postgresql-16.15"
./configure --prefix="$YUVI_LINUX_POSTGRES_HOME" --without-readline --without-zlib --without-icu --with-openssl --without-libxml --without-libxslt --without-tcl --without-gssapi --without-ldap --disable-nls
make -j2
make install
make -C contrib/pgcrypto -j2 install
make -C contrib/pg_trgm -j2 install
make -C "$task_build_dir/pgvector-0.8.6" -j2 PG_CONFIG="$YUVI_LINUX_POSTGRES_HOME/bin/pg_config" install
