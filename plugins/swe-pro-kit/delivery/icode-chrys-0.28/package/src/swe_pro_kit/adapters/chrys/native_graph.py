"""Build the evaluation graph using iCode's public workflow SDK.

Runs in the workflow worker. Only JSON task context and stage text cross edges;
the Harbor environment and its lifecycle remain in the calling process.
"""
from __future__ import annotations

import json

from chrys.workflows import Retry, WorkflowBuilder, WorkflowValue

from ...core.configuration import Bindings, Setting
from ...core.prompts import (
    _decoder_sample_prompt, _decoder_aggregate_prompt,
    _mapper_stage_prompt, _solver_stage_prompt,
)


def read_input(value):
    context = json.loads(value.text)
    if not isinstance(context["instruction"], str) or not context["instruction"].strip():
        raise ValueError("instruction must be nonempty")
    return WorkflowValue(text=context["instruction"], data=context)


def build_workflow(setting: Setting, bindings: Bindings):
    wf = WorkflowBuilder("SWE-Pro · iCode native workflow")
    request = wf.python("input", read_input)
    wf.start(request)

    def stage(role, profile):
        agent = wf.agent(role, profile=profile, retry=Retry(max_attempts=1))

        def nonempty(value):
            if not value.text.strip():
                raise ValueError(f"{role} returned no output")
            return value.text

        checked = wf.python(f"checked-{role}", nonempty)
        wf.edge(agent, checked)
        wf.output(checked)
        return agent, checked

    decoders = []
    for index in range(setting.decoder_count):
        agent, checked = stage(f"decoder-{index}", bindings.decoder)

        def prompt(sources, *, sample=index):
            context = sources[0].value.data
            return _decoder_sample_prompt(
                context["instruction"], context["decoder_workspaces"][sample],
                sample, setting.decoder_count,
            )

        # The preceding sample is a serial dependency only, never prompt context.
        sources = [request]
        if setting.decoder_execution == "serial" and decoders:
            sources.append(decoders[-1])
        wf.join(sources, agent, combine=prompt)
        decoders.append(checked)

    analysis = decoders[0]
    if setting.aggregate:
        aggregator, analysis = stage("aggregator", bindings.aggregator)

        def aggregate_input(sources):
            context = sources[0].value.data
            return _decoder_aggregate_prompt(
                context["instruction"], context["workdir"],
                [source.value.text for source in sources[1:]],
            )

        wf.join([request, *decoders], aggregator, combine=aggregate_input)

    mapper, plan = stage("mapper", bindings.mapper)
    solver, solution = stage("solver", bindings.solver)

    def mapper_input(sources):
        context = sources[0].value.data
        return _mapper_stage_prompt(context["instruction"], context["workdir"], sources[1].value.text)

    def solver_input(sources):
        context = sources[0].value.data
        return _solver_stage_prompt(context["instruction"], context["workdir"], sources[1].value.text)

    wf.join([request, analysis], mapper, combine=mapper_input)
    wf.join([request, plan], solver, combine=solver_input)
    return wf.build()
