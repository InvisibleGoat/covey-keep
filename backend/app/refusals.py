"""The 422 a request FastAPI refuses is answered with (CK-102's second fix-up).

It carries where (`loc`), what (`msg`), which (`type`) and, where pydantic
gives one, `ctx` — and NEVER THE VALUE IT REFUSED. FastAPI's own repeats that
value as `input`, and cannot always write it: half an emoji is not UTF-8,
`NaN` is not JSON, a nest can be too deep for the encoder to walk, bytes can
be no text at all. The failure is a 500, and its traceback prints the
`RequestValidationError` behind it, whose text is every refused value — a
message's words, or a sign-in request's address, in the API's log.

Three rules. What is kept is named, so a key pydantic adds later is left out
until someone chooses it. The entries are cut to that BEFORE the encoder sees
them, because the encoder walks whatever it is handed. And the answer is
written in ASCII, so no character can fail to be written.

Nothing here is logged. `app/main.py` registers it for the whole application;
a refusal a route raises itself (`api/gatherings.py::_field_422` and its like)
is an `HTTPException` in the same shape, and never had an `input`.
"""

import json

from fastapi import Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError

KEPT = ("type", "loc", "msg", "ctx")


async def refuse_without_the_value(request: Request, exc: RequestValidationError) -> Response:
    entries = [{key: entry[key] for key in KEPT if key in entry} for entry in exc.errors()]
    return Response(
        content=json.dumps({"detail": jsonable_encoder(entries)}, ensure_ascii=True, separators=(",", ":")),
        status_code=422,
        media_type="application/json",
    )
