import uuid
from datetime import datetime
from enum import Enum
from typing import Type

from sqlalchemy import DateTime, MetaData, Uuid, func, text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import DeclarativeBase, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def uuid_pk():
    return mapped_column(Uuid(), primary_key=True, server_default=text("gen_random_uuid()"))


def created_at_col():
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


def db_enum(enum_cls: Type[Enum], name: str) -> SAEnum:
    # Store the Python enums' .value (not member names) so DB labels match the schema doc.
    return SAEnum(enum_cls, name=name, values_callable=lambda e: [m.value for m in e])


# Re-exported for convenience in model modules.
UTCDateTime = DateTime(timezone=True)
UUID = uuid.UUID
Timestamp = datetime
