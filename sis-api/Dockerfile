# Dockerfile for SIS Admin API (JWT authentication)

# --- Build stage: install Python dependencies ---
FROM python:3.12-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# --- Runtime stage: clean image with patched OS packages ---
FROM python:3.12-slim

# Apply OS security patches plus the shared libs rasterio's GDAL wheel needs at runtime.
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends libexpat1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed Python packages from build stage (no gcc/build tools in runtime)
COPY --from=builder /install /usr/local
COPY shared.py .
COPY main.py .
COPY sampling_design.py .
COPY raster_registry/ ./raster_registry/

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
