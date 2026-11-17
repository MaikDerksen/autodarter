import asyncio
import logging
import sys

from .config import LOG_LEVEL


def main() -> None:
    # "python -m autodarter_board status|code|server …" -> command line instead of the board client
    if len(sys.argv) > 1:
        from .cli import main as cli

        sys.exit(cli(sys.argv[1:]))
    logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .app import BoardApp

    try:
        asyncio.run(BoardApp().run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
