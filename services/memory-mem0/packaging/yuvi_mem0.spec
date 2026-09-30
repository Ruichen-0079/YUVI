# -*- mode: python ; coding: utf-8 -*-
"""YUVI Mem0 Windows x64 onedir spec."""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


PACKAGING_DIR = Path(
    os.environ.get("YUVI_MEM0_SPEC_DIR", str(Path.cwd() / "packaging"))
).resolve()
MEMORY_ROOT = PACKAGING_DIR.parent
SOURCE_ROOT = MEMORY_ROOT / "src"
ENTRY = SOURCE_ROOT / "yuvi_mem0" / "__main__.py"


def _numpy_core_modules() -> list[str]:
    """Use the package helper while excluding NumPy test modules."""

    return [
        module
        for module in collect_submodules("numpy._core")
        if not module.endswith("_tests") and ".testing" not in module
    ]


hiddenimports = [
    *collect_submodules("yuvi_mem0"),
    *collect_submodules("uvicorn.protocols"),
    *collect_submodules("uvicorn.loops"),
    *collect_submodules("uvicorn.lifespan"),
    "fastapi",
    "starlette",
    "pydantic",
    "pydantic_core",
    "pydantic_settings",
    "dotenv",
    "dotenv.main",
    "mem0.memory.main",
    "mem0.memory.storage",
    "mem0.memory.setup",
    "mem0.memory.telemetry",
    "mem0.configs.base",
    "mem0.configs.llms.base",
    "mem0.configs.vector_stores.pgvector",
    # MemoryConfig's default validator imports this module at mem0 import
    # time; it is retained until a later source-level isolation change.
    "mem0.configs.vector_stores.qdrant",
    "mem0.embeddings.ollama",
    "mem0.vector_stores.pgvector",
    "mem0.llms.deepseek",
    "mem0.llms.openai",
    "mem0.utils.factory",
    "psycopg",
    "psycopg_binary",
    "psycopg_pool",
    "sqlalchemy",
    "mem0.memory.notices",
    "psycopg2",
    "httpx",
    "ollama",
    "openai",
    "certifi",
    "posthog",
    "qdrant_client",
    *_numpy_core_modules(),
]

datas = [
    *copy_metadata("mem0ai"),
    *collect_data_files("mem0", includes=["memory/oss_notices_config.json"]),
    *collect_data_files("certifi"),
]

a = Analysis(
    [str(ENTRY)],
    pathex=[str(SOURCE_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pkg_resources", "setuptools", "backports"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
if sys.platform.startswith("linux"):
    # The Debian 12 target ships a compatible libstdc++ (the collected
    # closure needs at most GLIBCXX 3.4.30). Never bundle the build host's
    # newer copy: the Linux ABI audit caps shipped natives at glibc 2.36.
    a.binaries = [
        entry
        for entry in a.binaries
        if not os.path.basename(entry[0]).startswith("libstdc++.so")
    ]
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="yuvi-mem0",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="mem0",
)
