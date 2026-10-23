"""Друкує OpenAPI-схему в stdout. Джерело для генерації TS-типів у packages/shared."""

import json
import sys

from tickets_api.core.config import Settings
from tickets_api.main import create_app


def main() -> None:
    app = create_app(Settings(app_env="test"))
    json.dump(app.openapi(), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
