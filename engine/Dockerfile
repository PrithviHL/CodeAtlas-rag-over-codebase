FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ENGINE_DATA=/data HF_HOME=/data/models
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/engine
COPY engine/pyproject.toml engine/requirements.lock ./
COPY engine/codeatlas_engine ./codeatlas_engine
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.15.0 && pip install --no-cache-dir -r requirements.lock && pip install --no-cache-dir --no-deps . && useradd --uid 10001 --create-home engine && mkdir /data && chown engine /data
USER engine
EXPOSE 8000
CMD ["uvicorn", "codeatlas_engine.service:app", "--host", "0.0.0.0", "--port", "8000"]
