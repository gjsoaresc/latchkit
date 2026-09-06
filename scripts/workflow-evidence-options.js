const supportedEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function validateWorkflowProviderOptions(values) {
  if (
    values.model !== undefined &&
    (typeof values.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/.test(values.model))
  )
    throw new Error('--model must be an explicit model identifier.');
  if (values['reasoning-effort'] !== undefined && !supportedEfforts.has(values['reasoning-effort']))
    throw new Error('--reasoning-effort must be low, medium, high, xhigh, max, or ultra.');
  // An explicit small model must not accidentally inherit an incompatible
  // ultra setting from the user's normal configuration. Global files are untouched.
  return {
    ...values,
    ...(values.model && values['reasoning-effort'] === undefined
      ? { 'reasoning-effort': 'medium' }
      : {}),
  };
}

export function workflowProviderInnerArgs(values) {
  values = validateWorkflowProviderOptions(values);
  return [
    ...(values['collect-usage'] ? ['--collect-usage'] : []),
    ...(values.model ? ['--model', values.model] : []),
    ...(values['reasoning-effort'] ? ['--reasoning-effort', values['reasoning-effort']] : []),
  ];
}

export function workflowProviderInvocation(options, values) {
  values = validateWorkflowProviderOptions(values);
  if (options.provider?.id !== 'codex') return options;
  if (options.plan?.args?.length === 1 && options.plan.args[0] === '--version') return options;
  const overrides = [
    ...(values.model ? ['--model', values.model] : []),
    ...(values['reasoning-effort']
      ? ['-c', `model_reasoning_effort="${values['reasoning-effort']}"`]
      : []),
  ];
  return overrides.length
    ? { ...options, plan: { ...options.plan, args: [...overrides, ...options.plan.args] } }
    : options;
}
