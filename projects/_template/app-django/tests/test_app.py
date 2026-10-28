from django.test import Client


def test_health(client: Client) -> None:
    assert client.get("/health").json() == {"ok": True}


def test_index(client: Client) -> None:
    assert client.get("/").json() == {"project": "__P__-__NAME__"}
