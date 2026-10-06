"""Check native graph inputs against the existing stage contract, without a model."""
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("chrys.workflows")
from chrys.workflows import SourceValue, WorkflowValue

SOURCE = Path(__file__).parents[1] / "plugins/swe-pro-kit/source"
sys.path.insert(0, str(SOURCE / "package/src"))
from swe_pro_kit.adapters.chrys.native_graph import build_workflow
from swe_pro_kit.core.configuration import Setting, Bindings, expected_stage_roles
from swe_pro_kit.core.prompts import (
    _decoder_sample_prompt, _decoder_aggregate_prompt, _mapper_stage_prompt, _solver_stage_prompt,
)


@pytest.mark.parametrize("count,execution,aggregate", [(1, "serial", False), (1, "parallel", True), (3, "parallel", True), (3, "serial", True)])
def test_graph_preserves_full_stage_prompts_and_explicit_composition(count, execution, aggregate):
    setting = Setting("icode-workflow", count, execution, aggregate)
    bindings = Bindings("Decoder", "Aggregator", "Mapper", "Solver")
    workflow = build_workflow(setting, bindings)
    graph = workflow.definition
    task = {"instruction": "original issue\n" + "evidence " * 2000,
            "workdir": "/canonical", "decoder_workspaces": [f"/private/{i}" for i in range(count)]}
    values = {}
    inputs = {}
    for node_id in graph.node_order:
        node = graph.nodes[node_id]
        if node.kind == "agent":
            assert node.retry.max_attempts == 1
        if node_id.startswith("checked-"):
            with pytest.raises(ValueError, match="returned no output"):
                node.fn(WorkflowValue(" \n"))
    while len(values) != len(graph.nodes):
        progress = False
        for node_id, node in graph.nodes.items():
            if node_id in values:
                continue
            sources = [edge.src for edge in graph.in_edges(node_id)]
            if any(source not in values for source in sources):
                continue
            if node_id == graph.start:
                result = node.fn(WorkflowValue(json.dumps(task)))
            elif node.kind == "join":
                result = node.fn([SourceValue(source, source, values[source]) for source in sources])
            elif node.kind == "agent":
                inputs[node_id] = values[sources[0]].text
                result = f"full output of {node_id}\n" + "details " * 2000
            else:
                result = node.fn(values[sources[0]])
            values[node_id] = result if isinstance(result, WorkflowValue) else WorkflowValue(result)
            progress = True
        assert progress, "graph must make progress without hidden mutable context"
    assert set(inputs) == set(expected_stage_roles(setting))
    for index in range(count):
        assert inputs[f"decoder-{index}"] == _decoder_sample_prompt(task["instruction"], f"/private/{index}", index, count)
    if aggregate:
        assert inputs["aggregator"] == _decoder_aggregate_prompt(task["instruction"], "/canonical", [values[f"decoder-{i}"].text for i in range(count)])
    analysis = values["aggregator" if aggregate else "decoder-0"].text
    assert inputs["mapper"] == _mapper_stage_prompt(task["instruction"], "/canonical", analysis)
    assert inputs["solver"] == _solver_stage_prompt(task["instruction"], "/canonical", values["mapper"].text)
    for index in range(1, count):
        incoming = [edge.src for edge in graph.in_edges(f"join:decoder-{index}")]
        assert incoming == (["input", f"checked-decoder-{index - 1}"] if execution == "serial" else ["input"])
