"""Entrypoint used in dev (`python -m app.main`) and wrapped by bootstrap.py for PyInstaller."""
from __future__ import annotations

import logging
import os

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app import voice

log = logging.getLogger("calib")


def create_app() -> FastAPI:
    app = FastAPI(title="Calibration Workbench Backend", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)

    @app.on_event("shutdown")
    async def _shutdown_voice() -> None:
        voice.stop_mobile_server()

    return app


app = create_app()


def main() -> None:
    host = os.environ.get("CALIB_HOST", "127.0.0.1")
    port = int(os.environ.get("CALIB_PORT", "8765"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info("calibration backend starting on %s:%d", host, port)
    uvicorn.run("app.main:app", host=host, port=port, log_level="info", workers=1)


if __name__ == "__main__":
    main()
