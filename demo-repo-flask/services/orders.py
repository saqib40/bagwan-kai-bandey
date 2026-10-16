from typing import Any, Dict, List

from services import catalog

_ORDERS: List[Dict[str, Any]] = []


def list_orders(limit: int = 10) -> List[Dict[str, Any]]:
    return list(_ORDERS)[:limit]


def create_order(product_id: int) -> Dict[str, Any]:
    product = catalog.get_product(product_id)
    order = {
        "id": len(_ORDERS) + 1,
        "product_id": product_id,
        "product": product["name"] if product else None,
    }
    _ORDERS.append(order)
    return order
