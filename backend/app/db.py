from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

# hide_parameters (CK-102's fix-up): a failed statement's exception carries
# its parameters, and uvicorn logs an escaped exception's traceback — so a
# connection the database dropped under a send wrote the message's words to
# the log, and one under a sign-in request the address. Hidden on every
# engine under `app/` (pinned), the worker's too; never turned off to debug.
engine = create_async_engine(settings.database_url, hide_parameters=True)

async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
