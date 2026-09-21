"""Normalize Responses streaming events for the existing validated action parser."""
from types import SimpleNamespace as NS

from .errors import AppError


def _chunk(*, content=None, name=None, arguments=None, finish=None, refusal=None):
    calls = [NS(index=0, function=NS(name=name, arguments=arguments))] if name is not None or arguments is not None else None
    return NS(usage=None, choices=[NS(finish_reason=finish, delta=NS(content=content, tool_calls=calls, refusal=refusal))])


class ResponsesChatStream:
    def __init__(self, client, *, model, messages, effort, max_tokens, tools):
        kwargs = {"model": model, "input": messages, "reasoning": {"effort": effort},
                  "max_output_tokens": max_tokens, "stream": True, "store": False}
        if tools:
            kwargs.update(tools=[{"type": "function", **tool["function"], "strict": False} for tool in tools], parallel_tool_calls=False)
        self.stream = client.responses.create(**kwargs)

    def close(self):
        self.stream.close()

    def __iter__(self):
        tool_id = None
        argument_deltas = False
        pending_tool = None
        finished = False
        for event in self.stream:
            kind = event.type
            if kind == "response.output_text.delta":
                yield _chunk(content=event.delta)
            elif kind == "response.refusal.delta":
                yield _chunk(refusal=event.delta)
            elif kind == "response.output_item.added" and event.item.type == "function_call":
                if tool_id is not None:
                    raise AppError("malformed_tool_call", "Choose one action at a time.", status=502)
                tool_id = event.item.id
                yield _chunk(name=event.item.name, arguments="")
            elif kind == "response.function_call_arguments.delta":
                argument_deltas = True
                yield _chunk(arguments=event.delta)
            elif kind == "response.output_item.done" and event.item.type == "function_call":
                pending_tool = event.item
            elif kind == "response.completed":
                if tool_id and pending_tool is None:
                    raise AppError("malformed_tool_call", "The action did not finish. Please try again.", status=502)
                finished = True
                if pending_tool:
                    yield _chunk(name=pending_tool.name, arguments="" if argument_deltas else pending_tool.arguments, finish="tool_calls")
                usage = event.response.usage
                if usage:
                    details = getattr(usage, "input_tokens_details", None)
                    yield NS(choices=[], usage=NS(prompt_tokens=usage.input_tokens,
                        completion_tokens=usage.output_tokens,
                        prompt_tokens_details=NS(cached_tokens=getattr(details, "cached_tokens", 0))))
            elif kind in {"response.failed", "response.incomplete", "error"}:
                raise AppError("stream_truncated", "The response did not finish. Please try again.", status=502)
        if not finished:
            raise AppError("stream_truncated", "The connection closed before the response finished.", status=502)


def reasoning_effort(messages, *, voice=False):
    """Spend extra thought on explicit analysis; keep short spoken turns light."""
    import re
    text = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    if re.search(r"\b(compare|trade.?offs?|evaluate|critique|analy[sz]e|reason|think (?:it |this )?through|recommend|justify|differentiat\w*|conflict)\b", text, re.IGNORECASE):
        return "medium"
    return "low"
