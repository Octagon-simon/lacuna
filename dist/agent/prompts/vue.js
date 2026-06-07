export function detectVue(packageDeps) {
    if (!packageDeps)
        return false;
    return /\bvue\b/.test(packageDeps);
}
export function buildVueGuidance() {
    return [
        'VUE PROJECT — use @testing-library/vue for component tests.',
        "Import render, screen, fireEvent, waitFor from '@testing-library/vue'",
        "Import userEvent from '@testing-library/user-event'",
        'Prefer screen queries over container.querySelector().',
        'Prefer getByRole() when possible.',
        'Vue DOM updates are asynchronous.',
        'After state-changing interactions, use waitFor() before asserting updated UI.',
        'Never perform user interactions inside waitFor().',
        'Never call fireEvent() inside waitFor().',
        'Never call userEvent actions inside waitFor().',
        'waitFor() callbacks must contain assertions only.',
        'Use findBy* queries when waiting for asynchronous UI.',
        'Use nextTick() only when Vue reactivity flushing must be awaited.',
        'Mock network requests and browser APIs.',
        'Do not perform real HTTP requests.',
        'Mock vue-router when testing isolated components.',
        'Mock Pinia stores when testing isolated components.',
        'Prefer jest.advanceTimersByTime() over runAllTimers() when fake timers are used.',
        'Avoid unnecessary cleanup() calls.',
    ].join('\n');
}
//# sourceMappingURL=vue.js.map