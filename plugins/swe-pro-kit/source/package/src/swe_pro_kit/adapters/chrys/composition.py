"""Bind the archived nested compositions without rewriting the atomic roles."""
from copy import deepcopy
from typing import Any
import yaml
from ...core.configuration import Setting, Bindings
from ...runtime.distribution import distribution_root


def _template(name: str) -> dict[str, Any]:
    return yaml.safe_load(
        (distribution_root() / "assets/compositions" / f"{name}.yaml").read_text(
            encoding="utf-8"
        )
    )


def build_orchestrator_profile(setting: Setting, bindings: Bindings, *, evaluation: Any = None) -> dict[str, Any]:
    if setting.executor != "sub-agent":
        raise ValueError("an orchestrator profile requires the sub-agent executor")
    root = _template("single-decoder" if setting.decoder_count == 1 else "three-decoder")
    root["name"] = "SWEProOrchestrator"
    roles = {"problem_decoder": bindings.decoder if setting.decoder_count == 1 else "SWEProDecoderOrchestrator",
             "solution_mapper": bindings.mapper, "problem_solver": bindings.solver}
    for ref in root["sub_agents"]["agents"]:
        ref["profile"] = roles[ref["tool_name"]]
    if setting.decoder_count != 1 and (setting.decoder_count != 3 or setting.decoder_execution != "parallel"):
        root["instructions"] = root["instructions"].replace("three", str(setting.decoder_count)).replace(
            "in parallel", "in series" if setting.decoder_execution == "serial" else "in parallel")
        for ref in root["sub_agents"]["agents"]:
            ref["tool_description"] = ref["tool_description"].replace("three", str(setting.decoder_count)).replace(
                "concurrently", "sequentially" if setting.decoder_execution == "serial" else "concurrently")
    if evaluation is not None:
        from .taskpattern import compose_orchestrator_profile
        root = compose_orchestrator_profile(root, evaluation)
    return root


def build_decoder_orchestrator_profile(setting: Setting, bindings: Bindings) -> dict[str, Any]:
    """The three-parallel preset retains the archived composition text verbatim.

    Other settings substitute only count, sample blocks and scheduling directives.
    """
    profile = _template("decoder-ensemble")
    profile["name"] = "SWEProDecoderOrchestrator"
    original = profile["sub_agents"]["agents"]
    children = []
    for i in range(setting.decoder_count):
        ref = deepcopy(original[0])
        ref.update(profile=bindings.decoder, tool_name=f"decoder_{i}")
        ref["tool_description"] = ref["tool_description"].replace("sample 0", f"sample {i}")
        children.append(ref)
    children.append(dict(original[-1], profile=bindings.aggregator))
    profile["sub_agents"] = {"max_total_concurrency": setting.decoder_count if setting.decoder_execution == "parallel" else 1,
                            "agents": children}
    profile["tools"]["sub_agents"] = [ref["tool_name"] for ref in children]
    text = profile["instructions"]
    if setting.decoder_count != 3:
        tools = ", ".join(f"`decoder_{i}`" for i in range(setting.decoder_count))
        text = text.replace("`decoder_0`, `decoder_1`, `decoder_2`", tools)
        text = text.replace("3-sample", f"{setting.decoder_count}-sample").replace("all 3", f"all {setting.decoder_count}")
        text = text.replace("(3 parallel", f"({setting.decoder_count} parallel")
        text = text.replace("[0|1|2] of 3", "[" + "|".join(map(str, range(setting.decoder_count))) + f"] of {setting.decoder_count}")
        text = text.replace("i = 0, 1, 2", "i = " + ", ".join(map(str, range(setting.decoder_count))))
        start = text.index("<problem_decoder_sample_0>")
        end = text.index("</problem_decoder_sample_2>", start) + len("</problem_decoder_sample_2>")
        text = text[:start] + "\n\n".join(f"<problem_decoder_sample_{i}>\n[CONTENT OF _decoder_sample_{i}.txt]\n</problem_decoder_sample_{i}>" for i in range(setting.decoder_count)) + text[end:]
    if setting.decoder_execution == "serial":
        text = text.replace("in parallel", "in index order, waiting for each result before the next call")
        text = text.replace("simultaneously", "sequentially")
        text = text.replace(f"in a SINGLE\nturn ({setting.decoder_count} parallel tool calls)", "in index order, waiting for each result before the next call")
        text = text.replace("in ONE turn (parallel tool calls)", "in index order, waiting for each result before the next call")
    profile["instructions"] = text
    return profile
