local M = {
  tests = {},
}

function M.test(name, fn)
  M.tests[#M.tests + 1] = { name = name, fn = fn }
end

function M.assert_true(value, message)
  if not value then
    error(message or 'expected value to be truthy')
  end
end

function M.assert_equal(actual, expected, message)
  if actual ~= expected then
    error((message or 'values differ') .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
  end
end

function M.assert_error(fn, pattern)
  local ok, err = pcall(fn)
  if ok then
    error('expected function to raise')
  end
  local text = type(err) == 'table' and err.message or tostring(err)
  if pattern and not tostring(text):match(pattern) then
    error('unexpected error: ' .. tostring(text))
  end
end

function M.run()
  local passed = 0
  for i = 1, #M.tests do
    local entry = M.tests[i]
    local ok, err = pcall(entry.fn)
    if not ok then
      io.stderr:write('FAIL ' .. entry.name .. '\n')
      io.stderr:write(tostring(err) .. '\n')
      os.exit(1)
    end
    passed = passed + 1
    io.stdout:write('ok - ' .. entry.name .. '\n')
  end
  io.stdout:write(string.format('%d tests passed\n', passed))
end

return M
