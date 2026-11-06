import asyncio
import logging

from .config import LOG_LEVEL


def main() -> None:
    logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .app import BoardApp

    try:
        asyncio.run(BoardApp().run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
