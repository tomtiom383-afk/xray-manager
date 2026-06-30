FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py config_gen.py ./
COPY static ./static

EXPOSE 8080

ENV PYTHONUNBUFFERED=1
ENV XRAY_AUTH_REQUIRED=true
ENV XRAY_COOKIE_SECURE=true

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
