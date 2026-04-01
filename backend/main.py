from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html, get_redoc_html

from backend.common.database import init_db
from backend.forecast_service.router import router as forecast_router
from backend.bid_engine_service.router import router as bid_router
from backend.risk_service.router import router as risk_router
from backend.audit_service.router import router as audit_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="Power Trading Platform API",
    description="AI-Powered Market Participation & Bid Preparation",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)


@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui():
    return get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=app.title + " - Docs",
        swagger_js_url="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js",
        swagger_css_url="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css",
    )


@app.get("/redoc", include_in_schema=False)
async def custom_redoc():
    return get_redoc_html(
        openapi_url=app.openapi_url,
        title=app.title + " - ReDoc",
        redoc_js_url="https://unpkg.com/redoc@next/bundles/redoc.standalone.js",
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

app.include_router(forecast_router, prefix="/api")
app.include_router(bid_router, prefix="/api")
app.include_router(risk_router, prefix="/api")
app.include_router(audit_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "power-trading-platform"}
