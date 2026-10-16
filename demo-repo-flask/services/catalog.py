from typing import Any, Dict, List, Optional

_PRODUCTS: List[Dict[str, Any]] = [
    {"id": 1, "name": "Widget", "price": 9.99},
    {"id": 2, "name": "Gadget", "price": 19.99},
]


def list_products() -> List[Dict[str, Any]]:
    return list(_PRODUCTS)


def get_product(product_id: int) -> Optional[Dict[str, Any]]:
    for product in _PRODUCTS:
        if product["id"] == product_id:
            return product
    return None
