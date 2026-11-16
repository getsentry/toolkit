// Grammar for a dashboard widget series: an aggregate, wrapped in the
// transformations Sentry applies to it. Calls nest like PromQL, and the
// innermost runs first:
//
//   count                                   no transformations
//   fill(count, zero)                       fill gaps with zeros
//   smooth(fill(p95:span.duration, linear), ema, 7)
//                                           fill, then smooth the result
//   smooth(count#2, sma, 5)                 the second `count` of the query
//
// The aggregate is whatever the dashboard `--query` shorthand takes
// (`count`, `p95:span.duration`, `p50(value,metric,distribution,none)`,
// `equation|count() / 60`): it ends at the comma or parenthesis outside its
// own brackets, parentheses, and quotes. `#<n>` after it picks one of
// several equal aggregates, counting from 1. Commands validate the
// aggregate itself; the grammar only checks the transformations.
//
// `pnpm run generate:grammar` compiles it, with the types in
// series-expression.d.ts, into the gitignored src/generated/; the build,
// typecheck, and test scripts run it.
//
// `parseSeriesExpression()` (src/commands/dashboard/transformations.ts)
// parses whole flag values. Shell completion passes `{ partial: true }` to
// parse the word typed so far instead: that returns where the word stops
// and what goes there next (an aggregate, a fill mode, a smoothing method,
// a window, or an EMA factor), never throwing for a prefix of valid input.

{
  const { partial = false } = options;

  // Kinds of the transformations already applied to `series`
  function kindsOf(series) {
    return series.transformations.map((step) => step.slice(0, step.indexOf("(")));
  }

  // `series` with one more transformation applied after the others
  function apply(series, kind, args) {
    if (kindsOf(series).includes(kind)) {
      error(`A series takes at most one ${kind} transformation.`);
    }
    return {
      ...series,
      transformations: [...series.transformations, `${kind}(${args.join(",")})`],
    };
  }
}

start
  = &{ return partial; } _ @partialSeries
  / _ @series _

series
  = fill
  / smooth
  / target

fill
  = "fill" _ "(" _ inner:series _ "," _ mode:fillMode _ ")" {
      return apply(inner, "fill", [mode]);
    }

smooth
  = "smooth" _ "(" _ inner:series _ "," _ args:smoothing _ ")" {
      return apply(inner, "smooth", args);
    }

fillMode
  = @("zero" / "linear" / "locf") !word

smoothing
  = "sma" !word _ "," _ window:window { return ["sma", window]; }
  / "ema" !word _ "," _ window:window factor:(_ "," _ @factor)? {
      return factor === null ? ["ema", window] : ["ema", window, factor];
    }
  / "asap" !word window:(_ "," _ @window)? {
      return window === null ? ["asap"] : ["asap", window];
    }

// A positive integer number of data points
window "window size"
  = digits:$[0-9]+ !word {
      const size = Number(digits);
      if (!Number.isSafeInteger(size) || size < 1) {
        error(`Window size ${digits} must be a positive integer.`);
      }
      return String(size);
    }

// EMA's smoothing factor, greater than 0 and at most 1
factor "smoothing factor"
  = number:$(([0-9]+ ("." [0-9]*)? / "." [0-9]+) ([eE] [+-]? [0-9]+)?) !word {
      const value = Number(number);
      if (!(value > 0 && value <= 1)) {
        error(`Smoothing factor ${number} must be greater than 0 and at most 1.`);
      }
      return String(value);
    }

target
  = !call aggregate:aggregate occurrence:("#" @occurrence)? {
      return {
        aggregate,
        transformations: [],
        ...(occurrence !== null && { occurrence }),
      };
    }

occurrence "occurrence number"
  = digits:$([1-9] [0-9]*) { return Number(digits); }

call
  = ("fill" / "smooth") _ "("

aggregate "aggregate"
  = text:$(aggregatePart+) { return text.trim(); }

aggregatePart
  = parentheses / brackets / quoted / [^(),#[\]"]

parentheses
  = "(" (parentheses / brackets / quoted / [^()[\]"])* ")"

brackets
  = "[" (parentheses / brackets / quoted / [^()[\]"])* "]"

quoted
  = '"' ("\\" . / [^"\\])* '"'

word
  = [a-zA-Z0-9_.]

// Named so that error messages leave it out of what they expect
_ "whitespace"
  = [ \t]*

// ---------------------------------------------------------------------------
// Completion: the word typed so far, which may stop anywhere. Each rule
// consumes the rest of the input or fails. `start` is where the part being
// typed begins. `frames` lists the transformations around it, outermost
// first; for an argument, the ones around the transformation it belongs to.
// ---------------------------------------------------------------------------

partialSeries
  = "fill" _ "(" _ series _ "," _ start:partialWord {
      return { kind: "fill-mode", start, frames: [] };
    }
  / "smooth" _ "(" _ series _ "," _ @partialSmoothing
  / kind:("fill" / "smooth") _ "(" _ inner:partialSeries {
      return { ...inner, frames: [kind, ...inner.frames] };
    }
  / partialTarget

partialSmoothing
  = method:("sma" / "ema" / "asap") _ "," _ start:partialDigits {
      return { kind: "window", method, start, frames: [] };
    }
  / "ema" _ "," _ window _ "," _ start:partialNumber {
      return { kind: "factor", start, frames: [] };
    }
  / start:partialWord {
      return { kind: "smooth-method", start, frames: [] };
    }

partialWord
  = [a-z]* !. { return location().start.offset; }

partialDigits
  = [0-9]* !. { return location().start.offset; }

partialNumber
  = [0-9.eE+-]* !. { return location().start.offset; }

// An aggregate, maybe still open (`p95(span.du`), or the name of a
// transformation being typed. Fails at a comma or `)` outside its
// parentheses: the word went past the aggregate.
partialTarget
  = text:$(.*) &{
      let depth = 0;
      let quoted = false;
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quoted) {
          if (char === "\\") {
            i += 1;
          } else if (char === '"') {
            quoted = false;
          }
        } else if (char === '"') {
          quoted = true;
        } else if (char === "(" || char === "[") {
          depth += 1;
        } else if (char === ")" || char === "]") {
          depth -= 1;
          if (depth < 0) {
            return false;
          }
        } else if (char === "," && depth === 0) {
          return false;
        }
      }
      return true;
    } {
      return { kind: "aggregate", start: location().start.offset, frames: [] };
    }
