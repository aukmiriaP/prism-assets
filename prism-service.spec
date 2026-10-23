from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules, copy_metadata

datas, binaries, hiddenimports = [], [], []
datas += [('model_worker.py', '.'), ('material_worker.py', '.'), ('blender_material.py', '.')]
for package in ['mlx', 'mlx_vlm', 'transformers']:
    datas += collect_data_files(package, include_py_files=True)
hiddenimports += collect_submodules('mlx_vlm.models.embedding_gemma2')
hiddenimports += collect_submodules('mlx_vlm.models.gemma4')
hiddenimports += [
    'uvicorn.logging', 'uvicorn.loops.asyncio', 'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets.websockets_impl', 'uvicorn.lifespan.on',
    'watchdog.observers.fsevents', 'transformers.models.auto',
    'transformers.models.gemma4', 'transformers.models.embedding_gemma2',
    'transformers.tokenization_utils_tokenizers',
]
for name in ['mlx', 'mlx-metal', 'mlx-vlm', 'transformers', 'tokenizers', 'safetensors',
             'huggingface_hub', 'numpy', 'Pillow', 'regex', 'requests', 'packaging',
             'tqdm', 'PyYAML', 'filelock', 'fsspec', 'sentencepiece']:
    datas += copy_metadata(name)

a = Analysis(['app_server.py'], pathex=['.'], binaries=binaries, datas=datas,
    hiddenimports=hiddenimports, hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=['torch', 'torchvision', 'tensorflow', 'jax', 'matplotlib', 'pytest',
              'IPython', 'notebook'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='prism-service',
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True,
    argv_emulation=False, target_arch='arm64', codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='prism-service')
