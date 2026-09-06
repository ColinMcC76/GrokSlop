const WAIT_FOR_USER_TOOL = {
    type: 'function',
    name: 'wait_for_user',
    description:
        'Call this when the latest audio does not need a spoken response, such as silence, background noise, hold music, TV audio, side conversation, or speech not addressed to the assistant. This tool helps end the turn without a spoken reply.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
};

const REALTIME_TOOLS = [WAIT_FOR_USER_TOOL];

function collectFunctionCalls(event) {
    const calls = [];
    if (
        event?.type === 'response.function_call_arguments.done' &&
        event.name &&
        event.call_id
    ) {
        calls.push({
            name: event.name,
            call_id: event.call_id,
            arguments: event.arguments,
        });
    }

    const outputs = event?.response?.output;
    if (Array.isArray(outputs)) {
        for (const item of outputs) {
            if (item?.type === 'function_call' && item.name && item.call_id) {
                calls.push({
                    name: item.name,
                    call_id: item.call_id,
                    arguments: item.arguments,
                });
            }
        }
    }

    if (event?.item?.type === 'function_call' && event.item.name && event.item.call_id) {
        calls.push({
            name: event.item.name,
            call_id: event.item.call_id,
            arguments: event.item.arguments,
        });
    }

    return calls;
}

function responseUsedWaitTool(event) {
    const outputs = event?.response?.output;
    if (!Array.isArray(outputs)) {
        return false;
    }
    return outputs.some(
        (item) => item?.type === 'function_call' && item.name === WAIT_FOR_USER_TOOL.name
    );
}

module.exports = {
    WAIT_FOR_USER_TOOL,
    REALTIME_TOOLS,
    collectFunctionCalls,
    responseUsedWaitTool,
};
