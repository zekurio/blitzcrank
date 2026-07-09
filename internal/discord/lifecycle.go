package discord

import "sync"

// taskGroup prevents WaitGroup.Add from racing with shutdown. Once stop is
// called, no new background task can be admitted and wait may safely run.
type taskGroup struct {
	mu      sync.Mutex
	closing bool
	wg      sync.WaitGroup
}

func (g *taskGroup) begin() (func(), bool) {
	g.mu.Lock()
	if g.closing {
		g.mu.Unlock()
		return nil, false
	}
	g.wg.Add(1)
	g.mu.Unlock()
	return g.wg.Done, true
}

func (g *taskGroup) goRun(run func()) bool {
	done, ok := g.begin()
	if !ok {
		return false
	}
	go func() {
		defer done()
		run()
	}()
	return true
}

func (g *taskGroup) stop() {
	g.mu.Lock()
	g.closing = true
	g.mu.Unlock()
}

func (g *taskGroup) wait() {
	g.wg.Wait()
}
