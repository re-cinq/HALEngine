describe('a suite with disabled tests', () => {
  xit('never runs', () => {
    expect(1).toBe(1);
  });

  it.skip('also never runs', () => {
    expect(2).toBe(2);
  });
});
