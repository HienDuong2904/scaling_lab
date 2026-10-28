from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with TestClient(app) as client:  # `with` runs the lifespan
        yield client


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"ok": True}


def test_index(client: TestClient) -> None:
    assert client.get("/").json() == {"project": "__P__-__NAME__"}
