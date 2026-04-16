from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html, get_redoc_html
from fastapi.staticfiles import StaticFiles

from common.database import init_db
from forecast_service.router import router as forecast_router
from bid_engine_service.router import router as bid_router
from risk_service.router import router as risk_router
from audit_service.router import router as audit_router
from scraper_service.router import router as scraper_router
from policy_service.router import router as policy_router
from approval_service.router import router as approval_router
from beckn_service.router import router as beckn_router
from jobs.scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(
    title="Power Trading Platform API",
    description="ML-Driven Market Participation & Bid Preparation",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)


@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui():
    _local_js = _STATIC_DIR / "swagger" / "swagger-ui-bundle.js"
    _local_css = _STATIC_DIR / "swagger" / "swagger-ui.css"
    js_url = (
        "/static/swagger/swagger-ui-bundle.js"
        if _local_js.exists()
        else "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"
    )
    css_url = (
        "/static/swagger/swagger-ui.css"
        if _local_css.exists()
        else "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"
    )
    return get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=app.title + " - Docs",
        swagger_js_url=js_url,
        swagger_css_url=css_url,
    )


@app.get("/redoc", include_in_schema=False)
async def custom_redoc():
    return get_redoc_html(
        openapi_url=app.openapi_url,
        title=app.title + " - ReDoc",
        redoc_js_url="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js",
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://*.vercel.app",
        "https://indian-energy-market-ai.vercel.app",
    ],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_STATIC_DIR = Path(__file__).parent / "static"
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")

app.include_router(forecast_router, prefix="/api")
app.include_router(bid_router, prefix="/api")
app.include_router(risk_router, prefix="/api")
app.include_router(audit_router, prefix="/api")
app.include_router(scraper_router, prefix="/api")
app.include_router(policy_router, prefix="/api")
app.include_router(approval_router, prefix="/api")
app.include_router(beckn_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "power-trading-platform"}
