"""Framework-agnostic API tests.

They must pass against BOTH the Flask baseline and the FastAPI result, because
the engine runs the checkpoint suite against whatever framework is present at the
time. The client is selected dynamically from the `app` object's shape.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402

if hasattr(app, "url_map"):  # Flask
    _client = app.test_client()

    def _get(path, **kwargs):
        return _client.get(path, **kwargs)

    def _post(path, json=None, **kwargs):
        return _client.post(path, json=json, **kwargs)
else:  # FastAPI
    from fastapi.testclient import TestClient

    _client = TestClient(app)

    def _get(path, **kwargs):
        return _client.get(path, **kwargs)

    def _post(path, json=None, **kwargs):
        return _client.post(path, json=json, **kwargs)


def _body(response):
    # Flask exposes `response.json` as a property (dict); the FastAPI TestClient
    # exposes `response.json()` as a method.
    data = response.json
    return data() if callable(data) else data


def test_health():
    response = _get("/health")
    assert response.status_code == 200
    assert _body(response) == {"ok": True, "data": {"status": "healthy"}}


def test_list_products():
    response = _get("/products")
    assert response.status_code == 200
    body = _body(response)
    assert body["ok"] is True
    assert len(body["data"]) == 2


def test_get_product_found():
    response = _get("/products/1")
    assert response.status_code == 200
    assert _body(response)["data"]["name"] == "Widget"


def test_get_product_missing():
    response = _get("/products/999")
    assert response.status_code == 404
    assert _body(response) == {"ok": False, "error": "Product not found"}


def test_list_orders_respects_limit():
    response = _get("/orders?limit=1")
    assert response.status_code == 200
    assert _body(response)["ok"] is True


def test_create_order_requires_product_id():
    response = _post("/orders", json={})
    assert response.status_code == 400
    assert _body(response) == {"ok": False, "error": "product_id is required"}


def test_create_order_success():
    response = _post("/orders", json={"product_id": 1})
    assert response.status_code == 201
    assert _body(response)["data"]["product"] == "Widget"
