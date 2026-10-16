from flask import Flask, request

from routes import paths
from services import catalog, orders
from utils.response import bad_request, created, not_found, ok

app = Flask(__name__)


@app.route(paths.HEALTH, methods=["GET"])
def health():
    return ok({"status": "healthy"})


@app.route(paths.PRODUCTS, methods=["GET"])
def list_products():
    return ok(catalog.list_products())


@app.route(paths.PRODUCTS + "/<int:product_id>", methods=["GET"])
def get_product(product_id: int):
    product = catalog.get_product(product_id)
    if product is None:
        return not_found("Product not found")
    return ok(product)


@app.route(paths.ORDERS, methods=["GET"])
def list_orders():
    limit = request.args.get("limit", default=10, type=int)
    return ok(orders.list_orders(limit))


@app.route(paths.ORDERS, methods=["POST"])
def create_order():
    payload = request.get_json(silent=True) or {}
    if "product_id" not in payload:
        return bad_request("product_id is required")
    order = orders.create_order(payload["product_id"])
    return created(order)
